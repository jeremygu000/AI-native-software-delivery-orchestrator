import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';

const [candidate, command, ...args] = process.argv.slice(2);
const profiles = {
  deepseek: { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' },
  copilot: { provider: 'github-copilot', model: 'gpt-6.1-sol', effort: 'medium' },
  codex: { provider: 'openai-codex', model: 'gpt-6.1-sol', effort: 'medium' }
};
const profile = profiles[candidate];
if (!profile || !['cli', 'worker', 'preflight', 'register'].includes(command)) {
  throw new Error('Usage: comparison-run deepseek|copilot|codex cli|worker|preflight|register');
}
const env = { ...process.env, ...parseEnv(await readFile('.env.local', 'utf8')) };
env.FORGE_WORKER_REPOSITORY_PATH = resolve(`.local/comparison-${candidate}`);
env.FORGE_WORKER_REVIEW_PROVIDER = profile.provider;
env.FORGE_WORKER_REVIEW_MODEL = profile.model;
env.FORGE_MODEL_REASONING_EFFORT = profile.effort;
env.TEMPORAL_TASK_QUEUE = `forge-comparison-${candidate}`;
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
  entry = 'apps/temporal-worker/local/bootstrap.mjs';
  parameters = ['authority'];
} else {
  for (const key of Object.keys(env)) {
    if (key.startsWith('LOCAL_')) {
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
