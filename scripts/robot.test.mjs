import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IDLE_SYNC_MS,
  monitorTargets,
  POLL_MS,
  shouldRescue,
  SOON_SYNC_MS,
  SOON_WINDOW_MS,
  syncInterval,
  validBaseUrl,
  finiteInteger,
} from './robot-policy.mjs';
import { runMonitor } from './robot-runner.mjs';
import { buildLiveSnapshot, mergeMonitorState } from './sofascore-sync.mjs';

const minute = 60_000;
const hour = 60 * minute;
const start = Date.parse('2026-09-09T19:00:00Z');
const match = (overrides = {}) => ({
  id: 'slovan',
  sofascoreId: 16938796,
  date: new Date(start).toISOString(),
  status: 'LIVE',
  voteOpen: false,
  voteClosesAt: null,
  ...overrides,
});
const state = (matches, lastSync) => ({
  matches,
  predictionHub: {
    sync: {
      enabled: true,
      lastSync: Number.isFinite(lastSync) ? new Date(lastSync).toISOString() : '',
      lastError: '',
    },
  },
});

void test('the cadence is 8 hours, then 15 minutes at H-10, then 5 minutes at kickoff', () => {
  const scheduled = match({ status: 'SCHEDULED' });
  assert.equal(syncInterval([], start), IDLE_SYNC_MS);
  assert.equal(syncInterval([scheduled], start - SOON_WINDOW_MS - 1), IDLE_SYNC_MS);
  assert.equal(syncInterval([scheduled], start - SOON_WINDOW_MS), SOON_SYNC_MS);
  assert.equal(syncInterval([scheduled], start - minute), SOON_SYNC_MS);
  assert.equal(syncInterval([scheduled], start), POLL_MS);
  assert.equal(monitorTargets([scheduled], start).length, 1);
  assert.equal(syncInterval([match()], start - hour), POLL_MS);
  assert.equal(syncInterval([match({ status: 'FINISHED' })], start + 6 * hour), POLL_MS);
  assert.equal(syncInterval([match({ status: 'FINISHED', voteOpen: true })], start + 6 * hour), IDLE_SYNC_MS);
});

void test('cancelled, postponed, abandoned, invalid and completed-vote matches stay idle', () => {
  for (const overrides of [
    { status: 'FINISHED', voteOpen: true },
    { status: 'FINISHED', voteClosesAt: new Date(start).toISOString() },
    { status: 'POSTPONED' },
    { status: 'CANCELED' },
    { status: 'ABANDONED' },
    { sofascoreId: null },
    { date: 'not-a-date' },
  ]) {
    assert.equal(monitorTargets([match(overrides)], start).length, 0);
    assert.equal(syncInterval([match(overrides)], start), IDLE_SYNC_MS);
  }
});

void test('the rescue uses the adaptive 8-hour, 15-minute and 5-minute limits', () => {
  const idle = state([], start);
  assert.equal(shouldRescue(idle, start + IDLE_SYNC_MS - 1), false);
  assert.equal(shouldRescue(idle, start + IDLE_SYNC_MS), true);

  const scheduled = match({ status: 'SCHEDULED', date: new Date(start + 9 * hour).toISOString() });
  const soon = state([scheduled], start);
  assert.equal(shouldRescue(soon, start + SOON_SYNC_MS - 1), false);
  assert.equal(shouldRescue(soon, start + SOON_SYNC_MS), true);

  const live = state([match()], start);
  assert.equal(shouldRescue(live, start + POLL_MS - 1), false);
  assert.equal(shouldRescue(live, start + POLL_MS), true);
  assert.equal(shouldRescue({ ...idle, predictionHub: { sync: { enabled: true, lastSync: new Date(start).toISOString(), lastError: '403' } } }, start), true);
});

void test('all 24 kickoff hours follow the same boundaries', () => {
  for (let localHour = 0; localHour < 24; localHour += 1) {
    const kickoff = Date.parse(`2026-01-20T${String(localHour).padStart(2, '0')}:00:00+01:00`);
    const scheduled = match({ status: 'SCHEDULED', date: new Date(kickoff).toISOString() });
    assert.equal(syncInterval([scheduled], kickoff - SOON_WINDOW_MS - 1), IDLE_SYNC_MS, `H${localHour}: before H-10`);
    assert.equal(syncInterval([scheduled], kickoff - SOON_WINDOW_MS), SOON_SYNC_MS, `H${localHour}: at H-10`);
    assert.equal(syncInterval([scheduled], kickoff - 1), SOON_SYNC_MS, `H${localHour}: before kickoff`);
    assert.equal(syncInterval([scheduled], kickoff), POLL_MS, `H${localHour}: at kickoff`);
  }
});

void test('the full kickoff-to-vote cycle works at every hour of the day', async () => {
  for (let localHour = 0; localHour < 24; localHour += 1) {
    const kickoff = Date.parse(`2026-01-20T${String(localHour).padStart(2, '0')}:00:00+01:00`);
    let clock = kickoff;
    let current = match({ status: 'SCHEDULED', date: new Date(kickoff).toISOString() });
    const calls = [];
    await runMonitor({
      now: () => clock,
      maximumMs: 11 * minute,
      sleep: async (ms) => { clock += ms; },
      readState: async () => state([current], kickoff - POLL_MS),
      syncFull: () => assert.fail(`full collection requested at ${localHour}:00`),
      syncLive: async () => {
        calls.push(clock);
        current = calls.length === 1
          ? match({ status: 'LIVE', date: new Date(kickoff).toISOString() })
          : match({ status: 'FINISHED', voteOpen: true, date: new Date(kickoff).toISOString() });
        return { ok: true, matchesState: [current], lastSync: new Date(clock).toISOString() };
      },
    });
    assert.deepEqual(calls, [kickoff, kickoff + POLL_MS], `${localHour}:00`);
  }
});

void test('1am, 3am and both daylight-saving transitions need no manual intervention', () => {
  const kickoffs = [
    '2026-01-20T01:00:00+01:00',
    '2026-01-20T03:00:00+01:00',
    '2026-03-29T01:00:00+01:00',
    '2026-03-29T03:00:00+02:00',
    '2026-10-25T02:00:00+02:00',
    '2026-10-25T02:00:00+01:00',
  ];
  for (const value of kickoffs) {
    const kickoff = Date.parse(value);
    const scheduled = match({ status: 'SCHEDULED', date: new Date(kickoff).toISOString() });
    assert.equal(syncInterval([scheduled], kickoff - 10 * hour), SOON_SYNC_MS, value);
    assert.equal(syncInterval([scheduled], kickoff), POLL_MS, value);
    assert.equal(syncInterval([match({ status: 'FINISHED', voteOpen: true, date: new Date(kickoff).toISOString() })], kickoff + 3 * hour), IDLE_SYNC_MS, value);
  }
});

void test('idle mode performs exactly one collection after eight hours', async () => {
  let clock = start;
  const calls = [];
  await runMonitor({
    now: () => clock,
    maximumMs: IDLE_SYNC_MS + 6 * minute,
    stayAlive: true,
    sleep: async (ms) => { clock += ms; },
    readState: async () => state([], start),
    syncLive: () => assert.fail('live collection requested'),
    syncFull: async () => {
      calls.push(clock);
      return { ok: true, matchesState: [], lastSync: new Date(clock).toISOString() };
    },
  });
  assert.deepEqual(calls, [start + IDLE_SYNC_MS]);
});

void test('a match under ten hours is refreshed every fifteen minutes', async () => {
  let clock = start - SOON_WINDOW_MS;
  const calls = [];
  const scheduled = match({ status: 'SCHEDULED' });
  await runMonitor({
    now: () => clock,
    maximumMs: 46 * minute,
    stayAlive: true,
    sleep: async (ms) => { clock += ms; },
    readState: async () => state([scheduled], start - SOON_WINDOW_MS),
    syncLive: () => assert.fail('live collection requested before kickoff'),
    syncFull: async () => {
      calls.push(clock);
      return { ok: true, matchesState: [scheduled], lastSync: new Date(clock).toISOString() };
    },
  });
  assert.deepEqual(calls, [start - SOON_WINDOW_MS + 15 * minute, start - SOON_WINDOW_MS + 30 * minute, start - SOON_WINDOW_MS + 45 * minute]);
});

void test('kickoff switches to five minutes until the vote opens, then returns to eight hours', async () => {
  let clock = start - 10 * minute;
  let current = match({ status: 'SCHEDULED' });
  let lastSync = clock;
  const liveCalls = [];
  const fullCalls = [];
  await runMonitor({
    now: () => clock,
    maximumMs: IDLE_SYNC_MS + 26 * minute,
    stayAlive: true,
    sleep: async (ms) => { clock += ms; },
    readState: async () => state([current], lastSync),
    syncFull: async () => {
      fullCalls.push(clock);
      lastSync = clock;
      return { ok: true, matchesState: [current], lastSync: new Date(clock).toISOString() };
    },
    syncLive: async () => {
      liveCalls.push(clock);
      lastSync = clock;
      if (liveCalls.length === 3) {
        current = match({
          status: 'FINISHED',
          voteOpen: true,
          voteClosesAt: new Date(clock + 48 * hour).toISOString(),
        });
      }
      return { ok: true, matchesState: [current], lastSync: new Date(clock).toISOString() };
    },
  });
  assert.deepEqual(liveCalls.slice(0, 3), [start, start + POLL_MS, start + 2 * POLL_MS]);
  assert.equal(liveCalls.length, 3);
  assert.deepEqual(fullCalls, [start + 2 * POLL_MS + IDLE_SYNC_MS]);
});

void test('temporary SofaScore failures keep retrying without human intervention', async () => {
  let clock = start;
  let calls = 0;
  await runMonitor({
    now: () => clock,
    maximumMs: 16 * minute,
    stayAlive: true,
    sleep: async (ms) => { clock += ms; },
    readState: async () => state([], Number.NaN),
    syncLive: () => assert.fail('live collection requested'),
    syncFull: async () => {
      calls += 1;
      if (calls < 4) throw new Error('SofaScore 403');
      return { ok: true, matchesState: [], lastSync: new Date(clock).toISOString() };
    },
  });
  assert.equal(calls, 4);
});

void test('a reported sync error triggers an immediate recovery even when data is fresh', async () => {
  let calls = 0;
  await runMonitor({
    now: () => start,
    readState: async () => ({
      ...state([], start),
      predictionHub: { sync: { enabled: true, lastSync: new Date(start).toISOString(), lastError: 'temporary error' } },
    }),
    syncLive: () => assert.fail('live collection requested'),
    syncFull: async () => {
      calls += 1;
      return { ok: true, matchesState: [], lastSync: new Date(start).toISOString() };
    },
    sleep: () => assert.fail('wait requested'),
  });
  assert.equal(calls, 1);
});

void test('a missing next-match market triggers a full recovery during a live match', async () => {
  let calls = 0;
  await runMonitor({
    now: () => start,
    maximumMs: minute,
    readState: async () => ({
      ...state([match()], start),
      predictionHub: {
        activeMatchId: 'brest',
        options: [],
        market: null,
        sync: {
          enabled: true,
          lastSync: new Date(start).toISOString(),
          lastError: '',
        },
      },
    }),
    syncLive: () => assert.fail('live-only collection requested'),
    syncFull: async () => {
      calls += 1;
      return {
        ok: true,
        matchesState: [match()],
        lastSync: new Date(start).toISOString(),
      };
    },
    sleep: () => assert.fail('wait requested'),
  });
  assert.equal(calls, 1);
});

void test('a status outage preserves the known live match', async () => {
  let clock = start;
  let reads = 0;
  let polls = 0;
  let current = match();
  await runMonitor({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    readState: async () => {
      reads += 1;
      if (reads === 2) throw new Error('timeout');
      return state([current], Number.NaN);
    },
    syncFull: () => assert.fail('archive requested'),
    syncLive: async () => {
      polls += 1;
      if (polls === 2) current = match({ status: 'FINISHED', voteOpen: true });
      return { ok: true, matchesState: [current], lastSync: new Date(clock).toISOString() };
    },
  });
  assert.equal(polls, 2);
});

void test('an unresolved live outage is never reported as a success', async () => {
  let clock = start;
  let calls = 0;
  await assert.rejects(runMonitor({
    now: () => clock,
    maximumMs: 11 * minute,
    sleep: async (ms) => { clock += ms; },
    readState: async () => state([match()], Number.NaN),
    syncFull: () => assert.fail('archive requested'),
    syncLive: async () => { calls += 1; throw new Error('network down'); },
  }), /network down/);
  assert.equal(calls, 3);
});

void test('a postponed match ends monitoring after authoritative confirmation', async () => {
  let current = match();
  let count = 0;
  await runMonitor({
    readState: async () => state([current], Number.NaN),
    now: () => start,
    sleep: () => assert.fail('unneeded wait'),
    syncFull: () => assert.fail('archive requested'),
    syncLive: async () => {
      count += 1;
      current = match({ status: 'POSTPONED' });
      return { ok: true, matchesState: [current], lastSync: new Date(start).toISOString() };
    },
  });
  assert.equal(count, 1);
});

void test('authentication errors are permanent and never disclose the token', async () => {
  await assert.rejects(runMonitor({
    readState: async () => { throw Object.assign(new Error('401'), { permanent: true }); },
    syncLive: () => assert.fail('live collection requested'),
    syncFull: () => assert.fail('full collection requested'),
    sleep: () => assert.fail('wait requested'),
  }), /401/);
});

void test('configuration rejects insecure URLs and invalid durations fall back safely', () => {
  assert.equal(validBaseUrl('https://psg-hub.fr/'), 'https://psg-hub.fr');
  for (const url of ['http://psg-hub.fr', 'https://psg-hub.fr/api/state', 'https://secret@psg-hub.fr', 'https://psg-hub.fr/?secret=1']) {
    assert.throws(() => validBaseUrl(url));
  }
  assert.equal(finiteInteger('oops', 325, 30, 325), 325);
});

void test('the compact match state receives the persisted sync time', () => {
  const merged = mergeMonitorState(
    { matches: [match()] },
    state([], start),
  );
  assert.equal(merged.predictionHub.sync.lastSync, new Date(start).toISOString());
  assert.throws(() => mergeMonitorState({ matches: null }, state([], start)), /incomplet/);
});

void test('live snapshot only asks for current event, lineup and final incidents', async () => {
  const paths = [];
  const snapshot = await buildLiveSnapshot([match()], async (path) => {
    paths.push(path);
    if (path.endsWith('lineups')) throw new Error('403');
    if (path.endsWith('incidents')) return { incidents: [] };
    return { event: { id: 16938796, status: { type: 'finished' } } };
  });
  assert.equal(snapshot.mode, 'live');
  assert.deepEqual(paths, ['event/16938796', 'event/16938796/lineups', 'event/16938796/incidents']);
  assert.ok(snapshot.responses['event/16938796']);
  assert.equal(snapshot.responses['event/16938796/lineups'], undefined);
});

void test('a response for a different event is rejected', async () => {
  await assert.rejects(buildLiveSnapshot([match()], async () => ({ event: { id: 99 } })), /incohérent/);
});

