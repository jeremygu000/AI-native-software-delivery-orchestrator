import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentCommandSandboxProfile } from '@ai-native-software-delivery-orchestrator/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { DockerReadOnlyCommandSandbox } from './docker-command-sandbox.js';

const directories: string[] = [];
const profile: AgentCommandSandboxProfile = {
  kind: 'docker-read-only',
  image: 'node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43',
  assurance: 'production-validation',
  network: 'deny',
  workspaceAccess: 'read-only',
  processTree: 'container',
  memoryBytes: 1_073_741_824,
  cpuCount: 2,
  pidLimit: 256
};

const createDockerScript = (directory: string, body: string): string => {
  const executable = join(directory, 'docker');
  writeFileSync(executable, `#!/bin/sh\n${body}\n`);
  chmodSync(executable, 0o755);
  return executable;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DockerReadOnlyCommandSandbox', () => {
  it('invokes Docker with read-only workspace and denied network', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-sandbox-'));
    directories.push(directory);
    const logPath = join(directory, 'arguments.txt');
    const executable = createDockerScript(directory, `printf '%s\\n' "$@" > "${logPath}"`);
    const sandbox = new DockerReadOnlyCommandSandbox({ dockerExecutable: executable });

    await expect(
      sandbox.execute({
        profile,
        executable: 'node',
        args: ['-e', "process.stdout.write('ok')"],
        cwd: directory,
        environment: { CI: '1' },
        trustedPath: '/trusted/bin',
        timeoutMs: 5_000,
        maxOutputBytes: 100
      })
    ).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    expect(readFileSync(logPath, 'utf8')).toContain('--network\nnone');
    expect(readFileSync(logPath, 'utf8')).toContain(`${directory}:/workspace:ro`);
    expect(readFileSync(logPath, 'utf8')).toContain('--read-only');
  });

  it('fails closed for a missing Docker adapter', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-sandbox-'));
    directories.push(directory);
    const request = {
      profile,
      executable: 'node',
      args: [],
      cwd: directory,
      environment: {},
      trustedPath: '/trusted/bin',
      timeoutMs: 5_000,
      maxOutputBytes: 100
    };
    await expect(
      new DockerReadOnlyCommandSandbox({
        dockerExecutable: join(directory, 'missing-docker')
      }).execute({
        ...request,
        profile
      })
    ).resolves.toMatchObject({ status: 'failed', detail: 'Command sandbox could not start' });
  });

  it('fails closed before spawning when the profile does not match Docker read-only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-sandbox-'));
    directories.push(directory);
    const sandbox = new DockerReadOnlyCommandSandbox();

    await expect(
      sandbox.execute({
        profile: {
          kind: 'macos-read-only',
          assurance: 'developer-only',
          network: 'deny',
          workspaceAccess: 'read-only',
          processTree: 'direct-child'
        },
        executable: 'node',
        args: [],
        cwd: directory,
        environment: {},
        trustedPath: '/trusted/bin',
        timeoutMs: 5_000,
        maxOutputBytes: 100
      })
    ).resolves.toMatchObject({ status: 'failed', detail: 'Unsupported command sandbox profile' });
  });

  it('honors a pre-aborted signal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-sandbox-'));
    directories.push(directory);
    const executable = createDockerScript(directory, 'while true; do sleep 1; done');
    const controller = new AbortController();
    controller.abort();

    await expect(
      new DockerReadOnlyCommandSandbox({
        dockerExecutable: executable,
        terminationGraceMs: 20
      }).execute({
        profile,
        executable: 'node',
        args: [],
        cwd: directory,
        environment: {},
        trustedPath: '/trusted/bin',
        timeoutMs: 5_000,
        maxOutputBytes: 100,
        signal: controller.signal
      })
    ).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('terminates timed-out, cancelled, and output-limited Docker commands', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-sandbox-'));
    directories.push(directory);
    const executable = createDockerScript(directory, 'trap "" TERM\nwhile true; do sleep 1; done');
    const sandbox = new DockerReadOnlyCommandSandbox({
      dockerExecutable: executable,
      terminationGraceMs: 20
    });
    const base = {
      profile,
      executable: 'node',
      args: [],
      cwd: directory,
      environment: {},
      trustedPath: '/trusted/bin',
      maxOutputBytes: 100
    };
    const timedOut = sandbox.execute({ ...base, timeoutMs: 20 });
    const controller = new AbortController();
    const cancelled = sandbox.execute({ ...base, timeoutMs: 5_000, signal: controller.signal });
    controller.abort();

    await expect(timedOut).resolves.toMatchObject({ status: 'timed-out' });
    await expect(cancelled).resolves.toMatchObject({ status: 'cancelled' });

    const outputExecutable = createDockerScript(
      directory,
      'trap "" TERM\nprintf "long output"\nwhile true; do sleep 1; done'
    );
    await expect(
      new DockerReadOnlyCommandSandbox({
        dockerExecutable: outputExecutable,
        terminationGraceMs: 20
      }).execute({
        ...base,
        timeoutMs: 5_000,
        maxOutputBytes: 4
      })
    ).resolves.toMatchObject({ status: 'output-limited', stdout: 'long' });
  });

  it('limits Docker stderr output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-sandbox-'));
    directories.push(directory);
    const executable = createDockerScript(directory, 'printf "long error" >&2');

    await expect(
      new DockerReadOnlyCommandSandbox({ dockerExecutable: executable }).execute({
        profile,
        executable: 'node',
        args: [],
        cwd: directory,
        environment: {},
        trustedPath: '/trusted/bin',
        timeoutMs: 5_000,
        maxOutputBytes: 4
      })
    ).resolves.toMatchObject({ status: 'output-limited', stderr: 'long' });
  });
});
