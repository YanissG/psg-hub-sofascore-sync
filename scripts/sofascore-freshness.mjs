import { shouldRescue, validBaseUrl, finiteInteger } from './robot-policy.mjs';
const baseUrl = process.env.PSG_HUB_SYNC_URL ? validBaseUrl(process.env.PSG_HUB_SYNC_URL) : '';
const maximumAge = Math.max(
  60_000,
  finiteInteger(process.env.SOFASCORE_MAX_AGE_MS, 12 * 60_000, 60_000, 30 * 60_000),
);

if (!baseUrl) {
  process.stdout.write('true');
  process.exit(0);
}

try {
  const response = await fetch(`${baseUrl}/api/state`, {
    redirect: 'error',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'user-agent': 'PSG-Hub-SofaScore-Watchdog/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`PSG Hub ${response.status}`);
  const state = await response.json();
  process.stdout.write(shouldRescue(state, Date.now(), maximumAge) ? 'true' : 'false');
} catch {
  process.stdout.write('true');
}
