import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { OAuthLoginCallbacks } from '@mariozechner/pi-ai/oauth';
import { FileSubscriptionCredentialStore } from './subscription-credential-store.js';

const { copilotLogin, codexLogin } = vi.hoisted(() => ({
  copilotLogin: vi.fn(),
  codexLogin: vi.fn()
}));
vi.mock('@mariozechner/pi-ai/oauth', () => ({
  githubCopilotOAuthProvider: { login: copilotLogin },
  openaiCodexOAuthProvider: { login: codexLogin }
}));
import { loginModelSubscription } from './subscription-login.js';

describe('Explicit independent subscription login', () => {
  it.each(['github-copilot', 'openai-codex'])(
    'uses only the selected %s OAuth flow and private store',
    async (provider) => {
      copilotLogin.mockReset();
      codexLogin.mockReset();
      const selected = provider === 'github-copilot' ? copilotLogin : codexLogin;
      const other = provider === 'github-copilot' ? codexLogin : copilotLogin;
      const callbacks: OAuthLoginCallbacks = { onAuth: vi.fn(), onPrompt: async () => '' };
      const credentials = {
        access: 'private-access',
        refresh: 'private-refresh',
        expires: Date.now() + 600000
      };
      selected.mockResolvedValue(credentials);
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-login-')));
      try {
        await loginModelSubscription(provider, directory, callbacks);
        expect(selected).toHaveBeenCalledWith(callbacks);
        expect(other).not.toHaveBeenCalled();
        expect(await new FileSubscriptionCredentialStore(directory).load(provider)).toEqual(
          credentials
        );
        await expect(loginModelSubscription('claude-future', directory, callbacks)).rejects.toThrow(
          'Unsupported'
        );
        const controller = new AbortController();
        selected.mockImplementationOnce(async () => {
          controller.abort();
          return { ...credentials, access: 'cancelled-access' };
        });
        await expect(
          loginModelSubscription(provider, directory, { ...callbacks, signal: controller.signal })
        ).rejects.toThrow('cancelled');
        expect(await new FileSubscriptionCredentialStore(directory).load(provider)).toEqual(
          credentials
        );
        selected.mockRejectedValue(new Error('Login cancelled'));
        await expect(loginModelSubscription(provider, directory, callbacks)).rejects.toThrow(
          'cancelled'
        );
        expect(await new FileSubscriptionCredentialStore(directory).load(provider)).toEqual(
          credentials
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
