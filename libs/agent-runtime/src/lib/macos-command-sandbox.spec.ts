import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { platform } from 'node:process';
import type { AgentCommandSandboxProfile } from '@ai-native-software-delivery-orchestrator/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { MacosReadOnlyCommandSandbox } from './macos-command-sandbox.js';

const directories: string[] = [];
const trustedPath = `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
const profile: AgentCommandSandboxProfile = {
  kind: 'macos-read-only',
  network: 'deny',
  workspaceAccess: 'read-only',
  processTree: 'direct-child'
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const describeMacos = platform === 'darwin' ? describe : describe.skip;

describeMacos('MacosReadOnlyCommandSandbox', () => {
  it('runs a validation command with read-only workspace access', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'command-sandbox-'));
    directories.push(workspacePath);
    const sandbox = new MacosReadOnlyCommandSandbox();

    await expect(
      sandbox.execute({
        profile,
        executable: 'node',
        args: ['-e', "process.stdout.write('validated')"],
        cwd: workspacePath,
        environment: {},
        trustedPath,
        timeoutMs: 5_000,
        maxOutputBytes: 100
      })
    ).resolves.toMatchObject({ status: 'completed', exitCode: 0, stdout: 'validated' });
  });

  it('denies workspace writes from a validation command', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'command-sandbox-'));
    directories.push(workspacePath);
    const target = join(workspacePath, 'created.txt');
    const sandbox = new MacosReadOnlyCommandSandbox();

    const result = await sandbox.execute({
      profile,
      executable: 'node',
      args: ['-e', "require('node:fs').writeFileSync('created.txt', 'forbidden')"],
      cwd: workspacePath,
      environment: {},
      trustedPath,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000
    });

    expect(result).toMatchObject({ status: 'completed' });
    if (result.status === 'completed') {
      expect(result.exitCode).not.toBe(0);
    }
    expect(existsSync(target)).toBe(false);
  });

  it('fails closed for a missing adapter binary', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'command-sandbox-'));
    directories.push(workspacePath);
    const request = {
      profile,
      executable: 'node',
      args: [],
      cwd: workspacePath,
      environment: {},
      trustedPath,
      timeoutMs: 5_000,
      maxOutputBytes: 100
    };
    await expect(
      new MacosReadOnlyCommandSandbox({ executable: '/missing/sandbox-exec' }).execute({
        ...request,
        profile
      })
    ).resolves.toMatchObject({ status: 'failed', detail: 'Command sandbox could not start' });
  });

  it('terminates timed-out, cancelled, and output-limited commands', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'command-sandbox-'));
    directories.push(workspacePath);
    const sandbox = new MacosReadOnlyCommandSandbox({ terminationGraceMs: 20 });
    const timedOut = sandbox.execute({
      profile,
      executable: 'node',
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: workspacePath,
      environment: {},
      trustedPath,
      timeoutMs: 20,
      maxOutputBytes: 100
    });
    const controller = new AbortController();
    const cancelled = sandbox.execute({
      profile,
      executable: 'node',
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: workspacePath,
      environment: {},
      trustedPath,
      timeoutMs: 5_000,
      maxOutputBytes: 100,
      signal: controller.signal
    });
    controller.abort();
    const limited = sandbox.execute({
      profile,
      executable: 'node',
      args: ['-e', "process.stdout.write('output too long')"],
      cwd: workspacePath,
      environment: {},
      trustedPath,
      timeoutMs: 5_000,
      maxOutputBytes: 4
    });

    await expect(timedOut).resolves.toMatchObject({ status: 'timed-out' });
    await expect(cancelled).resolves.toMatchObject({ status: 'cancelled' });
    await expect(limited).resolves.toMatchObject({ status: 'output-limited', stdout: 'outp' });
  });

  it('honors a pre-aborted validation command', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'command-sandbox-'));
    directories.push(workspacePath);
    const sandbox = new MacosReadOnlyCommandSandbox({ terminationGraceMs: 20 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      sandbox.execute({
        profile,
        executable: 'node',
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        cwd: workspacePath,
        environment: {},
        trustedPath,
        timeoutMs: 5_000,
        maxOutputBytes: 100,
        signal: controller.signal
      })
    ).resolves.toMatchObject({ status: 'cancelled' });
  });
});

describe('MacosReadOnlyCommandSandbox platform validation', () => {
  it('fails closed with explicit platform evidence outside Darwin', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'command-sandbox-'));
    directories.push(workspacePath);

    await expect(
      new MacosReadOnlyCommandSandbox({ platform: () => 'linux' }).execute({
        profile,
        executable: 'node',
        args: [],
        cwd: workspacePath,
        environment: {},
        trustedPath,
        timeoutMs: 5_000,
        maxOutputBytes: 100
      })
    ).resolves.toMatchObject({ status: 'failed', detail: 'macOS command sandbox requires Darwin' });
  });
});
