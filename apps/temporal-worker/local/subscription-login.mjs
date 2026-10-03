import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { loginModelSubscription } from '@ai-native-software-delivery-orchestrator/agent-runtime';

const [providerId, directory] = process.argv.slice(2);
if (directory === undefined || !['github-copilot', 'openai-codex'].includes(providerId)) {
  throw new Error(
    'Usage: subscription-login.mjs github-copilot|openai-codex /absolute/private/auth-directory'
  );
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Subscription login requires an interactive operator terminal');
}
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  await loginModelSubscription(providerId, resolve(directory), {
    onAuth: ({ url, instructions }) => {
      // Explicit interactive authorization instructions, never a token or session export.
      process.stdout.write(`${url}\n${instructions ?? ''}\n`);
    },
    onPrompt: ({ message }) => terminal.question(`${message}: `),
    onManualCodeInput: () => terminal.question('Authorization redirect URL: ')
  });
  process.stdout.write('Subscription authorization saved in the private host store.\n');
} catch {
  process.stderr.write('Subscription authorization failed; no provider diagnostic is printed.\n');
  process.exitCode = 1;
} finally {
  terminal.close();
}
