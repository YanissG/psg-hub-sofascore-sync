export const POLL_MS = 5 * 60_000;
export const WARMUP_MS = 90 * 60_000;
export const FINISHED_RETRY_MS = 48 * 60 * 60_000;

export function validBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('PSG_HUB_SYNC_URL doit être une origine HTTPS sans chemin.');
  }
  return url.origin;
}

export function monitorTargets(matches, now = Date.now()) {
  return matches.filter((match) => {
    const kickoff = Date.parse(match.date);
    if (!Number.isSafeInteger(Number(match.sofascoreId)) || Number(match.sofascoreId) <= 0 || !Number.isFinite(kickoff)) return false;
    if (['CANCELED', 'POSTPONED', 'ABANDONED'].includes(match.status)) return false;
    if (match.status === 'FINISHED') {
      // A closed, already-completed vote must never start another live loop.
      return !match.voteOpen && !match.voteClosesAt && kickoff >= now - FINISHED_RETRY_MS;
    }
    return (match.status === 'LIVE' || match.status === 'SCHEDULED') &&
      kickoff <= now + WARMUP_MS && kickoff >= now - FINISHED_RETRY_MS;
  });
}

export function shouldRescue(state, now = Date.now(), maximumAge = 12 * 60_000) {
  const last = Date.parse(state?.predictionHub?.sync?.lastSync || '');
  const sync = state?.predictionHub?.sync;
  // A fresh pre-match snapshot is not proof that someone is monitoring kickoff.
  if (monitorTargets(state?.matches || [], now).length) return true;
  return !sync?.enabled || Boolean(sync?.lastError) || !Number.isFinite(last) ||
    last > now + 60_000 || now - last > maximumAge;
}

export function finiteInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== undefined && value !== ''
    ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
