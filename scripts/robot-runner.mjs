import { FULL_SYNC_MS, POLL_MS, monitorTargets } from './robot-policy.mjs';

// All time and I/O are injected so a full match can be tested without touching production.
export async function runMonitor({ readState, syncLive, syncFull, sleep, now = Date.now, log = () => {}, maximumMs = 325 * 60_000, stayAlive = false, fullSyncMs = FULL_SYNC_MS }) {
  const started = now();
  let targets = [];
  let failures = 0;
  let didFullSync = false;
  let lastFullSyncAt = Number.NEGATIVE_INFINITY;
  let successful = false;
  let lastError;
  while (now() - started < maximumMs) {
    const tick = now();
    let state;
    try {
      state = await readState();
      targets = monitorTargets(state.matches, now());
    } catch (error) {
      if (error.permanent) throw error;
      lastError = error;
      log(`État indisponible, suivi conservé : ${error.message}`);
    }
    try {
      const hadTargets = targets.length > 0;
      if (hadTargets) {
        const result = await syncLive(targets);
        // Only authoritative state for these exact matches can end monitoring.
        if (Array.isArray(result.matchesState)) targets = monitorTargets(result.matchesState, now());
        if (!result.ok) throw new Error(result.error || 'Détails du match encore incomplets.');
      } else if (!didFullSync || (stayAlive && tick - lastFullSyncAt >= fullSyncMs)) {
        const result = await syncFull();
        if (Array.isArray(result.matchesState)) targets = monitorTargets(result.matchesState, now());
        if (!result.ok) throw new Error(result.error || 'Synchronisation incomplète.');
        didFullSync = true;
        lastFullSyncAt = tick;
      } else if (!state) {
        throw lastError;
      }
      successful = true;
      failures = 0;
      lastError = undefined;
      if (!targets.length && (!stayAlive || hadTargets)) {
        // Validate vote opening (or a postponement) with a fresh server read.
        const confirmed = await readState();
        targets = monitorTargets(confirmed.matches, now());
        if (!targets.length && !stayAlive) return { ok: true, completed: true };
      }
    } catch (error) {
      failures += 1;
      lastError = error;
      log(`Passage ${failures} à reprendre : ${error.message}`);
      if (error.permanent) throw error;
      if (!targets.length && failures >= 3) throw error;
    }
    const nextTick = tick + POLL_MS;
    if (nextTick >= started + maximumMs) break;
    // Five minutes between pass starts, not five minutes plus collection time.
    await sleep(Math.max(1_000, nextTick - now()));
  }
  if (!successful || targets.length || lastError) {
    throw new Error('Surveillance non terminée : relais nécessaire. ' + (lastError?.message || 'Vote non ouvert.'));
  }
  return { ok: true, completed: true };
}
