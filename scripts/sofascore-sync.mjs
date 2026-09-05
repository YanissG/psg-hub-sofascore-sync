import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validBaseUrl, finiteInteger } from './robot-policy.mjs';
import { runMonitor } from './robot-runner.mjs';

const baseUrl = process.env.PSG_HUB_SYNC_URL ? validBaseUrl(process.env.PSG_HUB_SYNC_URL) : '';
const token = String(process.env.SYNC_SECRET_TOKEN || '');
const PSG_ID = 1644;
const API_SOURCES = [
  {
    base: 'https://api-sofascore-com.translate.goog/api/v1',
    query: '_x_tr_sl=auto&_x_tr_tl=fr&_x_tr_hl=fr',
  },
  {
    base: 'https://www-sofascore-com.translate.goog/api/v1',
    query: '_x_tr_sl=auto&_x_tr_tl=fr&_x_tr_hl=fr',
  },
  { base: 'https://www.sofascore.com/api/v1', query: '' },
  { base: 'https://api.sofascore.com/api/v1', query: '' },
];


const endpoint = `${baseUrl}/api/sofascore-sync`;
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);
const browserHeaders = () => ({
  accept: 'application/json, text/plain, */*',
  'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
  referer: 'https://www.sofascore.com/',
  origin: 'https://www.sofascore.com',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'x-requested-with': randomBytes(16).toString('hex'),
});

let browser;
let page;
let browserReady;
let preferredSource;

async function directFetch(path) {
  let lastError;
  const sources = preferredSource ? [preferredSource, ...API_SOURCES.filter((source) => source !== preferredSource)] : API_SOURCES;
  for (const source of sources) {
    for (let attempt = 0; attempt < 1; attempt += 1) {
      try {
        const separator = path.includes('?') ? '&' : '?';
        const query = [
          source.query,
          `_psghub=${Date.now()}-${attempt}`,
        ]
          .filter(Boolean)
          .join('&');
        const response = await fetch(
          `${source.base}/${path}${separator}${query}`,
          {
            headers: browserHeaders(),
            signal: AbortSignal.timeout(5_000),
          },
        );
        if (response.ok) {
          const data = await response.json();
          preferredSource = source;
          return data;
        }
        lastError = new Error(`SofaScore ${response.status} sur ${path}`);
      } catch (error) {
        lastError = error;
      }
      await wait(750 * (attempt + 1));
    }
  }
  throw lastError ?? new Error(`SofaScore indisponible sur ${path}`);
}

async function browserFetch(path) {
  if (!browserReady) browserReady = (async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    const context = await browser.newContext({
      userAgent: browserHeaders()['user-agent'],
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
    });
    page = await context.newPage();
    await page.goto('https://www.sofascore.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await wait(1_500);
  })().catch(async (error) => {
    await browser?.close().catch(() => undefined);
    browser = undefined;
    browserReady = undefined;
    throw error;
  });
  await browserReady;

  const result = await page.evaluate(
    async ({ requestPath, requestedWith }) => {
      const separator = requestPath.includes('?') ? '&' : '?';
      const response = await fetch(
        `/api/v1/${requestPath}${separator}_psghub=${Date.now()}`,
        {
          headers: {
            accept: 'application/json, text/plain, */*',
            'x-requested-with': requestedWith,
          },
          credentials: 'include',
          signal: AbortSignal.timeout(20_000),
        },
      );
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
    },
    {
      requestPath: path,
      requestedWith: randomBytes(16).toString('hex'),
    },
  );
  if (!result.ok) {
    throw new Error(`SofaScore navigateur ${result.status} sur ${path}`);
  }
  return JSON.parse(result.body);
}

async function sofaFetch(path) {
  let directError;
  try {
    return await directFetch(path);
  } catch (error) {
    directError = error;
  }
  try {
    return await browserFetch(path);
  } catch (browserError) {
    throw new Error(
      [directError && errorMessage(directError), errorMessage(browserError)]
        .filter(Boolean)
        .join('; '),
    );
  }
}

async function collectPaged(responses, teamId, direction, maximumPages) {
  const events = [];
  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    const path = `team/${teamId}/events/${direction}/${pageIndex}`;
    const response = await sofaFetch(path);
    responses[path] = response;
    events.push(...(response.events ?? []));
    if (!response.hasNextPage) break;
  }
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function isFinished(event) {
  return ['finished', 'afterextra', 'afterpenalties'].includes(
    event.status?.type,
  );
}

function isScheduled(event) {
  return (
    !isFinished(event) &&
    !['canceled', 'postponed'].includes(event.status?.type)
  );
}

function nextPsgEvent(events) {
  const now = Date.now() / 1000;
  return events
    .filter((event) => isScheduled(event) && event.startTimestamp > now)
    .sort((left, right) => left.startTimestamp - right.startTimestamp)[0];
}

function opponentId(event) {
  return event.homeTeam?.id === PSG_ID ? event.awayTeam?.id : event.homeTeam?.id;
}

async function addEventDetails(responses, event, includeIncidents) {
  const eventId = String(event.id);
  responses[`event/${eventId}`] = { event };
  const lineupPath = `event/${eventId}/lineups`;
  try {
    responses[lineupPath] = await sofaFetch(lineupPath);
  } catch (error) {
    process.stderr.write(
      `Lineup différée ${eventId}: ${errorMessage(error)}\n`,
    );
  }
  if (includeIncidents) {
    const incidentPath = `event/${eventId}/incidents`;
    try {
      responses[incidentPath] = await sofaFetch(incidentPath);
    } catch (error) {
      process.stderr.write(
        `Incidents différés ${eventId}: ${errorMessage(error)}\n`,
      );
    }
  }
}

async function buildSnapshot() {
  const responses = {};
  const [lastEvents, nextEvents] = await Promise.all([
    // Le moteur PSG Hub consomme cinq pages d'historique pour calculer les
    // cotes sur deux saisons, et trois pages futures pour réconcilier le
    // calendrier. L'instantané doit donc contenir exactement ce périmètre.
    collectPaged(responses, PSG_ID, 'last', 5),
    collectPaged(responses, PSG_ID, 'next', 3),
  ]);
  responses[`team/${PSG_ID}/players`] = await sofaFetch(
    `team/${PSG_ID}/players`,
  );

  const nextEvent = nextPsgEvent(nextEvents);
  let opponentEvents = [];
  if (nextEvent) {
    const otherId = opponentId(nextEvent);
    if (otherId) {
      [opponentEvents, responses[`team/${otherId}/players`]] =
        await Promise.all([
          collectPaged(responses, otherId, 'last', 5),
          sofaFetch(`team/${otherId}/players`),
        ]);
    }
  }

  const recentPsg = lastEvents
    .filter(isFinished)
    .sort((left, right) => right.startTimestamp - left.startTimestamp)
    .slice(0, 6);
  const recentOpponent = opponentEvents
    .filter(isFinished)
    .sort((left, right) => right.startTimestamp - left.startTimestamp)
    .slice(0, 4);
  const now = Date.now() / 1000;
  const nearKickoff = [...lastEvents, ...nextEvents].filter(
    (event) =>
      Math.abs(event.startTimestamp - now) <= 6 * 60 * 60 &&
      !isFinished(event),
  );
  const detailEvents = [
    ...new Map(
      [...recentPsg, ...recentOpponent, ...nearKickoff].map((event) => [
        event.id,
        event,
      ]),
    ).values(),
  ];
  for (const event of detailEvents) {
    await addEventDetails(
      responses,
      event,
      recentPsg.some((candidate) => candidate.id === event.id),
    );
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    responses,
  };
}

export async function postSnapshot(snapshot, deep = false) {
  const response = await fetch(`${endpoint}${deep ? '?deep=1' : ''}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${token}`, accept: 'application/json',
      'content-type': 'application/json', 'user-agent': 'PSG-Hub-Automation/4.0',
    },
    body: JSON.stringify({ snapshot }),
    signal: AbortSignal.timeout(90_000),
  });
  if (response.status >= 300 && response.status < 400)
    throw Object.assign(new Error('Adresse PSG Hub obsolète : redirection interdite.'), { permanent: true });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 502 && Array.isArray(result.matchesState)) return result;
    throw Object.assign(new Error(`Synchronisation refusée (${response.status}): ${result.error || 'erreur inconnue'}`),
      { permanent: [400, 401, 403, 404, 405].includes(response.status) });
  }
  if (result.ok !== true || !result.lastSync) throw new Error('Réponse de synchronisation invalide.');
  process.stdout.write(`${new Date().toISOString()} · ${result.matches || 0} matchs · ${result.players || 0} joueurs · mode ${snapshot.mode || 'complet'}\n`);
  return result;
}

async function readMonitorState() {
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'manual',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: true }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Object.assign(new Error(`État PSG Hub ${response.status}`),
    { permanent: response.status >= 300 && response.status < 500 });
  const state = await response.json();
  if (!Array.isArray(state.matches)) throw new Error('État PSG Hub incomplet.');
  return state;
}

export async function buildLiveSnapshot(matches, fetchSofa = sofaFetch) {
  const responses = {};
  for (const match of matches) {
    const path = `event/${Number(match.sofascoreId)}`;
    const response = await fetchSofa(path);
    if (Number(response.event?.id) !== Number(match.sofascoreId)) throw new Error('Identifiant SofaScore incohérent.');
    responses[path] = response;
    const details = ['lineups', ...(isFinished(response.event) ? ['incidents'] : [])];
    for (const detail of details) {
      try { responses[`${path}/${detail}`] = await fetchSofa(`${path}/${detail}`); }
      catch (error) { process.stderr.write(`Détail différé ${path}/${detail}: ${errorMessage(error)}\n`); }
    }
  }
  return { schemaVersion: 1, mode: 'live', generatedAt: new Date().toISOString(), responses };
}

async function addHistoryRequests(snapshot, requests) {
  const queue = [...requests];
  let completed = 0;
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const request = queue.shift();
      if (!request) break;
      const eventId = String(request.eventId);
      const eventPath = `event/${eventId}`;
      const lineupPath = `event/${eventId}/lineups`;
      try {
        const [event, lineups] = await Promise.all([
          sofaFetch(eventPath),
          sofaFetch(lineupPath),
        ]);
        snapshot.responses[eventPath] = event;
        snapshot.responses[lineupPath] = lineups;
        completed += 1;
      } catch (error) {
        // Le rattrapage historique ne doit jamais empêcher le suivi du direct.
        process.stderr.write(
          `Historique différé ${eventId}: ${errorMessage(error)}\n`,
        );
      }
    }
  });
  await Promise.all(workers);
  return completed;
}

async function synchronize() {
  const snapshot = await buildSnapshot();
  let result = await postSnapshot(snapshot);
  if (result.hotWindow) return result;
  const historyPasses = finiteInteger(process.env.SOFASCORE_HISTORY_PASSES, 1, 0, 4);
  for (let pass = 0; pass < historyPasses; pass += 1) {
    const requests = Array.isArray(result.historyRequests) ? result.historyRequests : [];
    if (!requests.length) break;
    try {
      const completed = await addHistoryRequests(snapshot, requests);
      if (!completed) break;
      result = await postSnapshot(snapshot, true);
    } catch (error) {
      process.stderr.write(`Archives différées: ${errorMessage(error)}\n`);
      break;
    }
  }
  return result;
}

export async function main() {
  if (!baseUrl || !token) throw new Error('PSG_HUB_SYNC_URL et SYNC_SECRET_TOKEN doivent être configurés.');
  try {
    await runMonitor({
      readState: readMonitorState,
      syncLive: async (matches) => postSnapshot(await buildLiveSnapshot(matches)),
      syncFull: synchronize, sleep: wait,
      log: (message) => process.stderr.write(`${new Date().toISOString()} · ${message}\n`),
      maximumMs: finiteInteger(process.env.SOFASCORE_HOT_MAX_MINUTES, 325, 30, 325) * 60_000,
    });
  } finally {
    if (browser) await Promise.race([browser.close().catch(() => undefined), wait(5_000)]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), (error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  });
}

