import assert from 'node:assert/strict';
import test from 'node:test';
import { monitorTargets, shouldRescue, validBaseUrl, finiteInteger, POLL_MS } from './robot-policy.mjs';
import { runMonitor } from './robot-runner.mjs';
import { buildLiveSnapshot } from './sofascore-sync.mjs';

const start = Date.parse('2026-09-09T19:00:00Z');
const match = (overrides = {}) => ({ id: 'slovan', sofascoreId: 16938796, date: new Date(start).toISOString(), status: 'LIVE', voteOpen: false, voteClosesAt: null, ...overrides });

test('warmup starts 90 minutes before kickoff and follows delayed finals beyond five hours', () => {
  assert.equal(monitorTargets([match({ status: 'SCHEDULED' })], start - 90 * 60_000).length, 1);
  assert.equal(monitorTargets([match({ status: 'SCHEDULED' })], start - 91 * 60_000).length, 0);
  assert.equal(monitorTargets([match({ status: 'FINISHED' })], start + 6 * 60 * 60_000).length, 1);
});

test('completed, expired, postponed and cancelled matches do not spin forever', () => {
  for (const overrides of [{ status: 'FINISHED', voteOpen: true }, { status: 'FINISHED', voteClosesAt: new Date(start).toISOString() }, { status: 'POSTPONED' }, { status: 'CANCELED' }, { status: 'SCHEDULED', date: new Date(start + 86400000).toISOString() }]) {
    assert.equal(monitorTargets([match(overrides)], start).length, 0);
  }
});

test('a fresh pre-match sync cannot make the rescue skip kickoff', () => {
  const state = { matches: [match()], predictionHub: { sync: { enabled: true, lastSync: new Date(start).toISOString(), lastError: '' } } };
  assert.equal(shouldRescue(state, start), true);
  assert.equal(shouldRescue({ ...state, matches: [] }, start), false);
  assert.equal(shouldRescue({ ...state, matches: [] }, start + 13 * 60_000), true);
});

test('configuration rejects insecure URLs and invalid durations fall back safely', () => {
  assert.equal(validBaseUrl('https://psg-hub.fr/'), 'https://psg-hub.fr');
  for (const url of ['http://psg-hub.fr', 'https://psg-hub.fr/api/state', 'https://secret@psg-hub.fr', 'https://psg-hub.fr/?secret=1']) assert.throws(() => validBaseUrl(url));
  assert.equal(finiteInteger('oops', 325, 30, 325), 325);
});

test('live -> transient error -> missing final details -> opened vote, exactly five minutes apart', async () => {
  let clock = start;
  let current = match();
  const starts = [];
  let calls = 0;
  await runMonitor({
    now: () => clock, sleep: async (ms) => { clock += ms; }, readState: async () => ({ matches: [current] }),
    syncFull: () => { throw new Error('Archives must not run during a match'); },
    syncLive: async () => {
      starts.push(clock);
      clock += 30_000;
      calls += 1;
      if (calls === 1) throw new Error('SofaScore 503 on first pass');
      if (calls === 2) { current = match({ status: 'FINISHED' }); return { ok: false, error: 'Minutes not yet published', matchesState: [current] }; }
      current = match({ status: 'FINISHED', voteOpen: true, voteClosesAt: new Date(clock + 48 * 3600000).toISOString() });
      return { ok: true, matchesState: [current] };
    },
  });
  assert.deepEqual(starts, [start, start + POLL_MS, start + 2 * POLL_MS]);
});

test('another match with open votes cannot stop this match', async () => {
  let clock = start;
  let count = 0;
  const older = match({ id: 'older', sofascoreId: 9, status: 'FINISHED', voteOpen: true });
  let current = match();
  await runMonitor({
    now: () => clock, sleep: async (ms) => { clock += ms; }, readState: async () => ({ matches: [older, current] }),
    syncFull: () => assert.fail('archive requested'),
    syncLive: async (targets) => {
      assert.deepEqual(targets.map((row) => row.id), ['slovan']);
      count += 1;
      if (count === 2) current = match({ status: 'FINISHED', voteOpen: true });
      return { ok: true, voteOpened: true, matchesState: [older, current] };
    },
  });
  assert.equal(count, 2);
});

test('a postponed match ends monitoring after authoritative confirmation', async () => {
  let current = match();
  let count = 0;
  await runMonitor({ readState: async () => ({ matches: [current] }), now: () => start, sleep: () => assert.fail('unneeded wait'),
    syncFull: () => assert.fail('archive requested'), syncLive: async () => { count++; current = match({ status: 'POSTPONED' }); return { ok: true, matchesState: [current] }; } });
  assert.equal(count, 1);
});

test('network failure in status endpoint preserves the known match', async () => {
  let clock = start, reads = 0, polls = 0;
  let current = match();
  await runMonitor({ now: () => clock, sleep: async (ms) => { clock += ms; },
    readState: async () => { if (++reads === 2) throw new Error('timeout'); return { matches: [current] }; },
    syncFull: () => assert.fail('archive requested'), syncLive: async () => { if (++polls === 2) current = match({ status: 'FINISHED', voteOpen: true }); return { ok: true, matchesState: [current] }; },
  });
  assert.equal(polls, 2);
});

test('an outage never silently reports a successful run, including the first pass', async () => {
  let clock = start, calls = 0;
  await assert.rejects(runMonitor({ now: () => clock, maximumMs: 11 * 60_000, sleep: async (ms) => { clock += ms; },
    readState: async () => ({ matches: [match()] }), syncFull: () => assert.fail(),
    syncLive: async () => { calls++; throw new Error('network down'); },
  }), /Surveillance non terminée/);
  assert.equal(calls, 3);
});

test('off-match first-pass failure gets retried', async () => {
  let clock = start, calls = 0;
  await runMonitor({ now: () => clock, sleep: async (ms) => { clock += ms; }, readState: async () => ({ matches: [] }),
    syncLive: () => assert.fail(), syncFull: async () => { if (++calls === 1) throw new Error('timeout'); return { ok: true, matchesState: [] }; },
  });
  assert.equal(calls, 2);
});

test('authentication errors are permanent and never disclose the token', async () => {
  await assert.rejects(runMonitor({ readState: async () => { throw Object.assign(new Error('401'), { permanent: true }); },
    syncLive: () => assert.fail(), syncFull: () => assert.fail(), sleep: () => assert.fail(),
  }), /401/);
});

test('live snapshot only asks for current event, lineup and final incidents', async () => {
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

test('a response for a different event is rejected', async () => {
  await assert.rejects(buildLiveSnapshot([match()], async () => ({ event: { id: 99 } })), /incohérent/);
});
