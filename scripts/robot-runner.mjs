import { lastSyncTime, monitorTargets, POLL_MS, syncInterval } from './robot-policy.mjs';

function predictionPreparationMissing(state) {
  const hub = state?.predictionHub;
  return Boolean(
    hub?.activeMatchId &&
      (!hub.market || !Array.isArray(hub.options) || hub.options.length === 0),
  );
}

// All time and I/O are injected so a full match can be tested without touching production.
export async function runMonitor({ readState, syncLive, syncFull, sleep, now = Date.now, log = () => {}, maximumMs = 325 * 60_000, stayAlive = false }) {
  const started = now();
  let targets = [];
  let matches = [];
  let failures = 0;
  let knownLastSync = Number.NaN;
  let healthy = false;
  let lastError;
  while (now() - started < maximumMs) {
    const tick = now();
    let state;
    try {
      state = await readState();
      matches = state.matches;
      targets = monitorTargets(matches, now());
      const remoteLastSync = lastSyncTime(state);
      if (Number.isFinite(remoteLastSync) &&
          (!Number.isFinite(knownLastSync) || remoteLastSync > knownLastSync)) {
        knownLastSync = remoteLastSync;
      }
      healthy = true;
    } catch (error) {
      if (error.permanent) throw error;
      lastError = error;
      log(`État indisponible, suivi conservé : ${error.message}`);
    }
    try {
      const hadTargets = targets.length > 0;
      const interval = syncInterval(matches, now());
      const syncHealth = state?.predictionHub?.sync;
      const predictionRepairDue = predictionPreparationMissing(state);
      const due = predictionRepairDue || !syncHealth?.enabled || Boolean(syncHealth?.lastError) ||
        !Number.isFinite(knownLastSync) ||
        knownLastSync > tick + 60_000 || tick - knownLastSync >= interval;
      let result;
      if (due && hadTargets && !predictionRepairDue) {
        result = await syncLive(targets);
        // Only authoritative state for these exact matches can end monitoring.
      } else if (due) {
        result = await syncFull();
      } else if (!state) {
        throw lastError;
      }
      if (result) {
        if (Array.isArray(result.matchesState)) {
          matches = result.matchesState;
          targets = monitorTargets(matches, now());
        }
        if (!result.ok) throw new Error(result.error ||
          (hadTargets ? 'Détails du match encore incomplets.' : 'Synchronisation incomplète.'));
        const reportedLastSync = Date.parse(result.lastSync || '');
        knownLastSync = Number.isFinite(reportedLastSync) ? reportedLastSync : now();
      }
      healthy = true;
      failures = 0;
      lastError = undefined;
      if (!targets.length && !stayAlive && hadTargets) {
        // Validate vote opening (or a postponement) with a fresh server read.
        const confirmed = await readState();
        targets = monitorTargets(confirmed.matches, now());
        if (!targets.length) return { ok: true, completed: true };
      } else if (!targets.length && !stayAlive && result) {
        return { ok: true, completed: true };
      }
    } catch (error) {
      failures += 1;
      lastError = error;
      log(`Passage ${failures} à reprendre : ${error.message}`);
      if (error.permanent) throw error;
      if (!stayAlive && failures >= 3) throw error;
    }
    const nextTick = tick + POLL_MS;
    if (nextTick >= started + maximumMs) break;
    // Five minutes between pass starts, not five minutes plus collection time.
    await sleep(Math.max(1_000, nextTick - now()));
  }
  if (!healthy || lastError) {
    throw new Error('Surveillance non terminée : relais nécessaire. ' + (lastError?.message || 'Vote non ouvert.'));
  }
  return { ok: true, completed: true };
}

