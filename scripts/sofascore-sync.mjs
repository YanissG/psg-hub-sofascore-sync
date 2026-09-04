import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const baseUrl = String(
  process.env.PSG_HUB_SYNC_URL || '',
).replace(/\/$/, '');
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

if (!baseUrl || !token) {
  throw new Error(
    'PSG_HUB_SYNC_URL et SYNC_SECRET_TOKEN doivent être configurés.',
  );
}

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
let directBlocked = false;

async function directFetch(path) {
  let lastError;
  for (const source of API_SOURCES) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (response.ok) return response.json();
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
  if (!browser) {
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
      timeout: 45_000,
    });
    await wait(1_500);
  }

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
  if (!directBlocked) {
    try {
      return await directFetch(path);
    } catch (error) {
      directError = error;
      directBlocked = /SofaScore 403/.test(errorMessage(error));
    }
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
  const nearKickoff = nextEvents.filter(
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

async function postSnapshot(snapshot, deep = false) {
  snapshot.generatedAt = new Date().toISOString();
  const requestUrl = `${endpoint}${deep ? '?deep=1' : ''}`;
  const response = await fetch(requestUrl, {
    method: 'POST',
    // Une redirection vers un autre domaine retire l'en-tête Authorization.
    // On l'interdit pour signaler immédiatement une ancienne URL de production.
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'PSG-Hub-Automation/3.0',
    },
    body: JSON.stringify({ snapshot }),
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') || 'destination inconnue';
    throw new Error(
      `Adresse PSG Hub obsolète : ${requestUrl} redirige vers ${location}. ` +
        'PSG_HUB_SYNC_URL doit pointer directement vers le domaine public.',
    );
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Synchronisation refusée (${response.status}): ${result.error || 'erreur inconnue'}`,
    );
  }
  process.stdout.write(
    `${new Date().toISOString()} · ${result.matches || 0} matchs · ${result.players || 0} joueurs\n`,
  );
  return result;
}

async function addHistoryRequests(snapshot, requests) {
  const queue = [...requests];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const request = queue.shift();
      if (!request) break;
      const eventId = String(request.eventId);
      const eventPath = `event/${eventId}`;
      const lineupPath = `event/${eventId}/lineups`;
      const [event, lineups] = await Promise.all([
        sofaFetch(eventPath),
        sofaFetch(lineupPath),
      ]);
      snapshot.responses[eventPath] = event;
      snapshot.responses[lineupPath] = lineups;
    }
  });
  await Promise.all(workers);
}

async function synchronize() {
  const snapshot = await buildSnapshot();
  let result = await postSnapshot(snapshot);
  const historyPasses = Math.max(
    0,
    Math.min(6, Number(process.env.SOFASCORE_HISTORY_PASSES || 4)),
  );
  for (let pass = 0; pass < historyPasses; pass += 1) {
    const requests = Array.isArray(result.historyRequests)
      ? result.historyRequests
      : [];
    if (!requests.length) break;
    await addHistoryRequests(snapshot, requests);
    result = await postSnapshot(snapshot, true);
  }
  return result;
}

try {
  const first = await synchronize();

  // GitHub limite la fréquence native du cron. Pendant la fenêtre chaude d'un
  // match, ce même passage reste actif et relance la synchro toutes les 3 min.
  const hotPasses = Math.max(
    1,
    Math.min(5, Number(process.env.SOFASCORE_HOT_PASSES || 5)),
  );
  if (first.hotWindow) {
    for (let pass = 1; pass < hotPasses; pass += 1) {
      await wait(3 * 60_000);
      await synchronize();
    }
  }
} finally {
  if (browser) {
    const closeDeadline = setTimeout(() => process.exit(0), 5_000);
    await browser.close().catch(() => undefined);
    clearTimeout(closeDeadline);
  }
}

process.exit(0);
