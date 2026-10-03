import {
  githubCopilotOAuthProvider,
  openaiCodexOAuthProvider,
  type OAuthLoginCallbacks
} from '@mariozechner/pi-ai/oauth';
import { FileSubscriptionCredentialStore } from './subscription-credential-store.js';

/** Operator-initiated login only. Browser/device authorization is never run by a workflow. */
export const loginModelSubscription = async (
  providerId: string,
  directory: string,
  callbacks: OAuthLoginCallbacks
): Promise<void> => {
  const provider =
    providerId === 'github-copilot'
      ? githubCopilotOAuthProvider
      : providerId === 'openai-codex'
        ? openaiCodexOAuthProvider
        : undefined;
  if (provider === undefined) {
    throw new Error('Unsupported subscription login provider');
  }
  const store = new FileSubscriptionCredentialStore(directory);
  await store.withLock(providerId, async () => {
    const credentials = await provider.login(callbacks);
    await store.save(providerId, credentials);
  });
};
