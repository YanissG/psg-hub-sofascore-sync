const baseUrl = String(process.env.PSG_HUB_SYNC_URL || '').replace(/\/$/, '');
const token = String(process.env.SYNC_SECRET_TOKEN || '');

if (!baseUrl || !token) {
  throw new Error(
    'PSG_HUB_SYNC_URL et SYNC_SECRET_TOKEN doivent être configurés.',
  );
}

const endpoint = `${baseUrl}/api/sofascore-sync`;
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function synchronize() {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'PSG-Hub-GitHub-Scheduler/1.0',
    },
    body: JSON.stringify({ trigger: true }),
    signal: AbortSignal.timeout(150_000),
  });
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

const first = await synchronize();
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
