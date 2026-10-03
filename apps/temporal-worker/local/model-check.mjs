import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import {
  ApprovedPiHostModelProxy,
  PiCodeReviewModelResolver
} from '@ai-native-software-delivery-orchestrator/agent-runtime';

const root = resolve(import.meta.dirname, '../../..');
const path = resolve(root, '.env.local');
let text = await readFile(path, 'utf8');
for (const [name, value] of Object.entries({
  FORGE_WORKER_REVIEW_PROVIDER: 'deepseek',
  FORGE_WORKER_REVIEW_MODEL: 'deepseek-flash',
  FORGE_REASONING_EFFORT: 'high',
  FORGE_PI_IMAGE: execFileSync(
    'docker',
    ['image', 'inspect', 'forge-isolated-pi:groundgraph', '--format', '{{.Id}}'],
    { encoding: 'utf8' }
  ).trim()
})) {
  text = text.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`);
}
await writeFile(path, text, { mode: 0o600 });
const env = parseEnv(text);
if (!env.FORGE_MODEL_API_KEY?.trim()) {
  throw new Error('Host model key is missing');
}
const model = new PiCodeReviewModelResolver().resolve({
  provider: 'deepseek',
  id: 'deepseek-flash'
});
const proxy = new ApprovedPiHostModelProxy({
  model,
  apiKey: env.FORGE_MODEL_API_KEY,
  reasoning: 'high'
});
try {
  const reply = await proxy.complete(
    {
      messages: [{ role: 'user', content: 'Reply with exactly READY.', timestamp: Date.now() }],
      tools: []
    },
    [],
    AbortSignal.timeout(60_000)
  );
  console.log(
    JSON.stringify({
      model: model.id,
      thinking: 'enabled',
      reasoning: 'high',
      ready: reply.content.some((part) => part.type === 'text' && part.text.trim() === 'READY')
    })
  );
} catch {
  console.error('Model check failed; credentials and provider diagnostics are not printed');
  process.exitCode = 1;
}
