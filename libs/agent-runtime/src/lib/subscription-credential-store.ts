import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { OAuthCredentials } from '@mariozechner/pi-ai/oauth';
import type { SubscriptionCredentialStore } from './model-execution-provider.js';
import { protocolObject } from './pi-session-protocol.js';

const providerName = (provider: string): string => {
  if (!['github-copilot', 'openai-codex'].includes(provider)) {
    throw new Error('Unsupported subscription credential provider');
  }
  return provider;
};
export const parseSubscriptionCredentials = (value: unknown): OAuthCredentials => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid subscription credential record');
  }
  const record = protocolObject(value);
  if (
    typeof record.access !== 'string' ||
    record.access.trim().length === 0 ||
    typeof record.refresh !== 'string' ||
    record.refresh.trim().length === 0 ||
    typeof record.expires !== 'number' ||
    !Number.isSafeInteger(record.expires) ||
    record.expires <= 0
  ) {
    throw new Error('Invalid subscription credential record');
  }
  return { ...record, access: record.access, refresh: record.refresh, expires: record.expires };
};

/** Explicit host-only store. No implicit discovery/import of CLI or editor sessions. */
export class FileSubscriptionCredentialStore implements SubscriptionCredentialStore {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) {
      throw new Error('Subscription credential directory must be absolute');
    }
  }
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      (await realpath(this.directory)) !== this.directory
    ) {
      throw new Error(
        'Subscription credential directory must be canonical, private and owned by this user'
      );
    }
  }
  async load(provider: string): Promise<OAuthCredentials> {
    await this.prepare();
    const file = await open(
      join(this.directory, `${providerName(provider)}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        stat.size > 64 * 1024
      ) {
        throw new Error('Subscription credential file is not private');
      }
      return parseSubscriptionCredentials(JSON.parse(await file.readFile('utf8')));
    } finally {
      await file.close();
    }
  }
  async save(provider: string, credentials: OAuthCredentials): Promise<void> {
    await this.prepare();
    const name = providerName(provider);
    const temporary = join(this.directory, `.${name}-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(parseSubscriptionCredentials(credentials)), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, join(this.directory, `${name}.json`));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  async withLock<T>(provider: string, work: () => Promise<T>): Promise<T> {
    await this.prepare();
    const path = join(this.directory, `.${providerName(provider)}.lock`);
    // An orphan lock is an explicit operator-recovery condition, never timed out away.
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        lock = await open(path, 'wx', 0o600);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
          throw error;
        }
        await sleep(50);
      }
    }
    if (lock === undefined) {
      throw new Error('Subscription refresh lock is held; operator recovery may be required');
    }
    try {
      return await work();
    } finally {
      await lock.close();
      await unlink(path);
    }
  }
}
