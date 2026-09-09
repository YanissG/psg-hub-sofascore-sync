export const POLL_MS = 5 * 60_000;
export const SOON_SYNC_MS = 15 * 60_000;
export const IDLE_SYNC_MS = 8 * 60 * 60_000;
export const SOON_WINDOW_MS = 10 * 60 * 60_000;
export const FINISHED_RETRY_MS = 48 * 60 * 60_000;

export function validBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('PSG_HUB_SYNC_URL doit être une origine HTTPS sans chemin.');
  }
  return url.origin;
}

function validKickoff(match) {
  const kickoff = Date.parse(match?.date);
  return Number.isSafeInteger(Number(match?.sofascoreId)) &&
    Number(match.sofascoreId) > 0 && Number.isFinite(kickoff)
    ? kickoff
    : Number.NaN;
}

function isStopped(match) {
  return ['CANCELED', 'POSTPONED', 'ABANDONED'].includes(match?.status);
}

export function monitorTargets(matches = [], now = Date.now()) {
  return matches.filter((match) => {
    const kickoff = validKickoff(match);
    if (!Number.isFinite(kickoff) || isStopped(match)) return false;
    if (match.status === 'FINISHED') {
      // A closed, already-completed vote must never start another live loop.
      return !match.voteOpen && !match.voteClosesAt && kickoff >= now - FINISHED_RETRY_MS;
    }
    // If SofaScore still says "scheduled" at kickoff, the five-minute loop must
    // start anyway. This avoids depending on an external status flip.
    return (match.status === 'LIVE' ||
      (match.status === 'SCHEDULED' && kickoff <= now)) &&
      kickoff >= now - FINISHED_RETRY_MS;
  });
}

export function hasUpcomingMatch(matches = [], now = Date.now()) {
  return matches.some((match) => {
    const kickoff = validKickoff(match);
    return Number.isFinite(kickoff) && !isStopped(match) &&
      match.status === 'SCHEDULED' && kickoff > now &&
      kickoff - now <= SOON_WINDOW_MS;
  });
}

export function syncInterval(matches = [], now = Date.now()) {
  if (monitorTargets(matches, now).length) return POLL_MS;
  if (hasUpcomingMatch(matches, now)) return SOON_SYNC_MS;
  return IDLE_SYNC_MS;
}

export function lastSyncTime(state) {
  const parsed = Date.parse(state?.predictionHub?.sync?.lastSync || '');
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function shouldRescue(state, now = Date.now(), maximumAge) {
  const last = Date.parse(state?.predictionHub?.sync?.lastSync || '');
  const sync = state?.predictionHub?.sync;
  const allowedAge = Number.isFinite(maximumAge)
    ? maximumAge
    : syncInterval(state?.matches || [], now);
  return !sync?.enabled || Boolean(sync?.lastError) || !Number.isFinite(last) ||
    last > now + 60_000 || now - last >= allowedAge;
}

export function finiteInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== undefined && value !== ''
    ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
