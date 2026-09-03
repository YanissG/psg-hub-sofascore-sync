const baseUrl = String(process.env.PSG_HUB_SYNC_URL || '').replace(/\/$/, '');
const maximumAge = Math.max(
  60_000,
  Number(process.env.SOFASCORE_MAX_AGE_MS || 12 * 60_000),
);

if (!baseUrl) {
  process.stdout.write('true');
  process.exit(0);
}

try {
  const response = await fetch(`${baseUrl}/api/state`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'PSG-Hub-SofaScore-Watchdog/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`PSG Hub ${response.status}`);
  const state = await response.json();
  const lastSync = new Date(state?.predictionHub?.sync?.lastSync || 0).getTime();
  const healthy =
    state?.predictionHub?.sync?.enabled === true &&
    !state?.predictionHub?.sync?.lastError &&
    Number.isFinite(lastSync) &&
    Date.now() - lastSync <= maximumAge;
  process.stdout.write(healthy ? 'false' : 'true');
} catch {
  process.stdout.write('true');
}
