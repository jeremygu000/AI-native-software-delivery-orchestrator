import type {
  AgentCommandSandbox,
  RepositoryGraph,
  TaskVerificationRequest
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  resolveVerificationPolicy,
  SandboxedPackageScriptVerifier
} from './sandboxed-package-script-verifier.js';

const profile = {
  kind: 'docker-read-only',
  image: `node@sha256:${'a'.repeat(64)}`,
  assurance: 'production-validation',
  network: 'deny',
  workspaceAccess: 'read-only',
  processTree: 'container',
  memoryBytes: 512_000_000,
  cpuCount: 1,
  pidLimit: 32
} as const;

const graph: RepositoryGraph = {
  repositoryPath: '/repository',
  projects: new Map([
    [
      'core-id',
      {
        id: 'core-id',
        name: 'core-name',
        root: 'packages/core',
        packageJsonPath: 'packages/core/package.json',
        dependencies: [],
        scripts: { test: 'node test.js' },
        sourceRoots: ['packages/core'],
        tsconfigPaths: []
      }
    ]
  ]),
  projectDependencies: [],
  files: new Map(),
  symbols: new Map(),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

const request = (
  verification: TaskVerificationRequest['task']['verification']
): TaskVerificationRequest => ({
  runId: 'run-1',
  task: {
    id: 'task-1',
    title: 'Verify',
    goal: 'Verify',
    dependencies: [],
    expectedReads: [],
    expectedWrites: [],
    sharedResources: [],
    verification
  },
  workspace: {
    id: 'workspace-1',
    runId: 'run-1',
    taskId: 'task-1',
    workspacePath: '/workspace',
    integrationRepositoryPath: '/repository',
    branchName: 'task-1',
    baseRef: 'base',
    integrationRef: 'main',
    revision: 1,
    phase: 'READY_TO_INTEGRATE'
  }
});

describe('SandboxedPackageScriptVerifier', () => {
  it('pins temporary dependency execution settings into an explicit verification policy', () => {
    const base = {
      version: 2,
      autonomousRules: ['package-script-required', 'free-form-command-forbidden'],
      packageScriptRunner: 'npm-from-pinned-node-image',
      executionProfile: profile
    } as const;
    expect(resolveVerificationPolicy(base, {})).toBe(base);
    const configured = resolveVerificationPolicy(base, {
      FORGE_VERIFICATION_IMAGE: `sha256:${'b'.repeat(64)}`,
      FORGE_VERIFICATION_TEMPORARY_BYTES: '2147483648',
      FORGE_VERIFICATION_TEMPORARY_EXECUTABLE: 'true'
    });
    expect(configured.executionProfile).toEqual({
      ...profile,
      image: `sha256:${'b'.repeat(64)}`,
      temporaryBytes: 2147483648,
      temporaryExecutable: true
    });
    expect(base.executionProfile).toEqual(profile);
    expect(() =>
      resolveVerificationPolicy(base, { FORGE_VERIFICATION_TEMPORARY_EXECUTABLE: 'true' })
    ).toThrow('explicitly pinned');
    expect(() =>
      resolveVerificationPolicy(base, { FORGE_VERIFICATION_IMAGE: 'node:latest' })
    ).toThrow('digest pinned');
    for (const value of ['0', '4294967297', 'NaN']) {
      expect(() =>
        resolveVerificationPolicy(base, {
          FORGE_VERIFICATION_IMAGE: `sha256:${'b'.repeat(64)}`,
          FORGE_VERIFICATION_TEMPORARY_BYTES: value
        })
      ).toThrow('Invalid');
    }
  });
  it('rejects unpinned images before any sandbox command', () => {
    expect(
      () =>
        new SandboxedPackageScriptVerifier({
          graph,
          policy: {
            version: 2,
            autonomousRules: ['package-script-required', 'free-form-command-forbidden'],
            packageScriptRunner: 'npm-from-pinned-node-image',
            executionProfile: { ...profile, image: 'node:latest' }
          }
        })
    ).toThrow('sha256 digest');
  });

  it('executes only approved package scripts using pinned read-only Docker settings', async () => {
    const execute = vi.fn<AgentCommandSandbox['execute']>().mockResolvedValue({
      status: 'completed',
      exitCode: 0,
      stdout: '',
      stderr: ''
    });
    const verifier = new SandboxedPackageScriptVerifier({
      graph,
      policy: {
        version: 2,
        autonomousRules: ['package-script-required', 'free-form-command-forbidden'],
        packageScriptRunner: 'npm-from-pinned-node-image',
        executionProfile: profile
      },
      sandbox: { execute }
    });

    await expect(
      verifier.verify(
        request([{ type: 'package-script', packageName: 'core-name', script: 'test' }])
      )
    ).resolves.toEqual({ status: 'passed' });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        executable: 'npm',
        args: ['--prefix', 'packages/core', 'run', 'test'],
        cwd: '/workspace',
        environment: { CI: '1', HOME: '/tmp', npm_config_cache: '/tmp/npm-cache' },
        timeoutMs: 600_000,
        maxOutputBytes: 1024 * 1024,
        containerName: expect.stringMatching(/^forge-verify-/)
      })
    );
    await expect(
      verifier.verify(request([{ type: 'package-script', packageName: 'core-id', script: 'test' }]))
    ).resolves.toEqual({ status: 'passed' });
    await expect(
      verifier.verify(request([{ type: 'command', command: 'npm test' }]))
    ).resolves.toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('package-script')
    });
    await expect(
      verifier.verify(request([{ type: 'package-script', packageName: 'unknown', script: 'test' }]))
    ).resolves.toMatchObject({ status: 'failed', detail: expect.stringContaining('unknown') });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ status: 'completed', exitCode: 1, stdout: '', stderr: 'failed tests' }, 'failed tests'],
    [{ status: 'timed-out', stdout: '', stderr: '' }, 'timed-out'],
    [
      { status: 'failed', detail: 'sandbox unavailable', stdout: '', stderr: '' },
      'sandbox unavailable'
    ]
  ] as const)('fails verification for sandbox result %j', async (result, detail) => {
    const verifier = new SandboxedPackageScriptVerifier({
      graph,
      policy: {
        version: 2,
        autonomousRules: ['package-script-required', 'free-form-command-forbidden'],
        packageScriptRunner: 'npm-from-pinned-node-image',
        executionProfile: profile
      },
      sandbox: { execute: async () => result }
    });
    await expect(
      verifier.verify(request([{ type: 'package-script', packageName: 'core-id', script: 'test' }]))
    ).resolves.toMatchObject({ status: 'failed', detail: expect.stringContaining(detail) });
  });
});
