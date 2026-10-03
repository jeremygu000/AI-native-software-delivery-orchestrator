import { mkdtemp, chmod, readFile, lstat, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileSubscriptionCredentialStore,
  parseSubscriptionCredentials
} from './subscription-credential-store.js';

describe('Private subscription credential store', () => {
  it('stores providers separately with atomic private files and exclusive refresh lock', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-subscription-')));
    try {
      const store = new FileSubscriptionCredentialStore(directory);
      const credentials = {
        access: 'private-access',
        refresh: 'private-refresh',
        expires: Date.now() + 600_000,
        accountId: 'host-only'
      };
      await store.save('github-copilot', credentials);
      expect(await store.load('github-copilot')).toEqual(credentials);
      expect((await lstat(join(directory, 'github-copilot.json'))).mode & 0o777).toBe(0o600);
      await expect(store.load('openai-codex')).rejects.toThrow();
      await store.withLock('github-copilot', async () => {
        await store.withLock('openai-codex', async () => undefined);
      });
      await store.withLock('github-copilot', async () =>
        store.save('github-copilot', { ...credentials, access: 'rotated' })
      );
      expect(
        JSON.parse(await readFile(join(directory, 'github-copilot.json'), 'utf8')).access
      ).toBe('rotated');
      await chmod(join(directory, 'github-copilot.json'), 0o644);
      await expect(store.load('github-copilot')).rejects.toThrow('private');
      await expect(store.save('../outside', credentials)).rejects.toThrow('Unsupported');
      await chmod(directory, 0o755);
      await expect(store.save('github-copilot', credentials)).rejects.toThrow('private');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('refuses symlinks and malformed or credential-less records', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-subscription-')));
    const link = `${directory}-link`;
    try {
      await symlink(directory, link);
      await expect(
        new FileSubscriptionCredentialStore(link).load('github-copilot')
      ).rejects.toThrow();
      expect(() => new FileSubscriptionCredentialStore('relative')).toThrow('absolute');
      for (const value of [
        null,
        [],
        {},
        { access: '', refresh: 'r', expires: 1 },
        { access: 'a', refresh: 'r', expires: Number.NaN }
      ]) {
        expect(() => parseSubscriptionCredentials(value)).toThrow();
      }
    } finally {
      await rm(link, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
