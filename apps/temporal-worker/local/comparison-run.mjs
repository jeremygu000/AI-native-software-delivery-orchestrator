import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { forgeModelProfiles } from '@ai-native-software-delivery-orchestrator/agent-runtime';

const [candidate, command, ...args] = process.argv.slice(2);
const providers = {
  deepseek: 'deepseek',
  copilot: 'github-copilot',
  codex: 'openai-codex'
};
const profile = forgeModelProfiles.find((entry) => entry.provider === providers[candidate]);
if (!profile || !['cli', 'worker', 'preflight', 'register'].includes(command)) {
  throw new Error('Usage: comparison-run deepseek|copilot|codex cli|worker|preflight|register');
}
if (command === 'cli') {
  for (const [option, expected] of [
    ['--review-provider', profile.provider],
    ['--review-model', profile.model]
  ]) {
    let occurrences = 0;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === option || argument.startsWith(`${option}=`)) {
        occurrences += 1;
        const value = argument === option ? args[index + 1] : argument.slice(option.length + 1);
        if (occurrences > 1 || value !== expected || args.slice(0, index).includes('--')) {
          throw new Error(`Comparison CLI requires one canonical ${option} for the candidate`);
        }
      }
    }
    if (['plan', 'run'].includes(args[0]) && occurrences !== 1) {
      throw new Error(`Comparison CLI requires explicit ${option} for the candidate`);
    }
  }
}
const neonComparison = process.env.FORGE_COMPARISON_ENV_FILE !== undefined;
const comparison = neonComparison
  ? parseEnv(await readFile(process.env.FORGE_COMPARISON_ENV_FILE, 'utf8'))
  : {};
const env = { ...process.env, ...parseEnv(await readFile('.env.local', 'utf8')), ...comparison };
// Database-owner credentials belong exclusively to the explicit hardening tool.
delete env.FORGE_DATABASE_OWNER_CONNECTION_STRING;
delete env.FORGE_DATABASE_HARDENING_ENV_FILE;
const prefix = neonComparison ? 'neon-comparison' : 'comparison';
env.FORGE_WORKER_REPOSITORY_PATH = resolve(`.local/${prefix}-${candidate}`);
env.FORGE_WORKER_REVIEW_PROVIDER = profile.provider;
env.FORGE_WORKER_REVIEW_MODEL = profile.model;
env.FORGE_MODEL_REASONING_EFFORT = profile.reasoningEffort;
env.TEMPORAL_TASK_QUEUE = `forge-${prefix}-${candidate}`;
env.FORGE_SUBSCRIPTION_AUTH_DIRECTORY = join(homedir(), '.config/forge/subscription-auth');
if (profile.provider !== 'deepseek') {
  delete env.FORGE_MODEL_API_KEY;
}
if (process.env.FORGE_PREPARE_ONLY === 'true') {
  env.FORGE_PREPARE_ONLY = 'true';
}
let entry;
let parameters = args;
if (command === 'register') {
  entry = neonComparison
    ? 'apps/temporal-worker/local/neon-comparison-authority.mjs'
    : 'apps/temporal-worker/local/bootstrap.mjs';
  parameters = neonComparison ? ['register', candidate] : ['authority'];
} else {
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('LOCAL_') ||
      [
        'FORGE_OWNER_CONNECTION_STRING',
        'FORGE_TRUST_CONNECTION_STRING',
        'FORGE_ISSUER_CONNECTION_STRING',
        'FORGE_SETUP_CONNECTION_STRING',
        'FORGE_RECOVERY_CONNECTION_STRING'
      ].includes(key)
    ) {
      delete env[key];
    }
  }
  entry = command === 'cli' ? 'apps/cli/dist/main.js' : 'apps/temporal-worker/dist/main.js';
  if (command === 'preflight') {
    parameters = ['--preflight'];
  }
}
const child = spawn(process.execPath, [resolve(entry), ...parameters], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
