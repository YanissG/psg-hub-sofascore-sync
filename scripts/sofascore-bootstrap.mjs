import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = String(process.env.GITHUB_REPOSITORY || '');
const githubToken = String(process.env.GITHUB_TOKEN || '');
const workflow = String(
  process.env.SOFASCORE_BOOTSTRAP_WORKFLOW || 'sofascore-bootstrap.yml',
);
const branch = String(process.env.SOFASCORE_BOOTSTRAP_BRANCH || 'main');
const intervalMs = Math.max(
  60_000,
  Number(process.env.SOFASCORE_BOOTSTRAP_INTERVAL_MS || 15 * 60_000),
);
const passes = Math.max(
  1,
  Math.min(22, Number(process.env.SOFASCORE_BOOTSTRAP_PASSES || 22)),
);
const collector = fileURLToPath(new URL('./sofascore-sync.mjs', import.meta.url));
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function runCollector() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      resolve(success);
    };
    const child = spawn(process.execPath, [collector], {
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      process.stderr.write(`Collecteur impossible à lancer: ${error.message}\n`);
      finish(false);
    });
    child.once('exit', (code) => finish(code === 0));
  });
}

async function scheduledAutomationIsProven() {
  if (!repository) return false;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/runs?event=schedule&status=success&per_page=20`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: githubToken ? `Bearer ${githubToken}` : '',
          'user-agent': 'PSG-Hub-SofaScore-Bootstrap/1.0',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) return false;
    const payload = await response.json();
    const freshnessLimit = Date.now() - 45 * 60_000;
    const recentNames = new Set(
      (payload.workflow_runs || [])
        .filter(
          (run) =>
            run.conclusion === 'success' &&
            new Date(run.updated_at || run.created_at || 0).getTime() >=
              freshnessLimit,
        )
        .map((run) => run.name),
    );
    return (
      recentNames.has('Synchronisation SofaScore') &&
      recentNames.has('Secours SofaScore')
    );
  } catch {
    return false;
  }
}

async function dispatchSuccessor() {
  if (!repository || !githubToken) {
    throw new Error('Relais GitHub non configuré.');
  }
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${githubToken}`,
        'content-type': 'application/json',
        'user-agent': 'PSG-Hub-SofaScore-Bootstrap/1.0',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ref: branch }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Relais GitHub refusé (${response.status}).`);
  }
}

let successfulPasses = 0;
for (let pass = 0; pass < passes; pass += 1) {
  const startedAt = Date.now();
  if (await runCollector()) successfulPasses += 1;
  if (await scheduledAutomationIsProven()) {
    process.stdout.write(
      'Les crons principal et de secours ont réussi : le relais peut s’arrêter.\n',
    );
    process.exit(successfulPasses ? 0 : 1);
  }
  if (pass < passes - 1) {
    await wait(Math.max(60_000, intervalMs - (Date.now() - startedAt)));
  }
}

await dispatchSuccessor();
process.stdout.write('Relais suivant programmé automatiquement.\n');
process.exit(successfulPasses ? 0 : 1);
