import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { describe, expect, it } from 'vitest';
import { authorityConfigurationFingerprint } from '@ai-native-software-delivery-orchestrator/persistence';
import { resolveWorkerDeployment } from './worker-deployment-config.js';
import { deploymentProbes, inspectWorkerDeployment } from './worker-preflight.js';

const configuration = (overrides: NodeJS.ProcessEnv = {}) => {
  const authority = {
    backend: 'postgres' as const,
    connectionString: 'postgres://runtime:private-password@localhost/forge',
    schema: 'forge',
    role: 'runtime'
  };
  return resolveWorkerDeployment({
    FORGE_WORKER_REPOSITORY_PATH: '/repository',
    FORGE_AUTHORITY_BACKEND: 'postgres',
    FORGE_POSTGRES_CONNECTION_STRING: authority.connectionString,
    FORGE_POSTGRES_SCHEMA: authority.schema,
    FORGE_POSTGRES_ROLE: authority.role,
    FORGE_AUTHORITY_ID: authorityConfigurationFingerprint(authority),
    FORGE_WORKER_REVIEW_PROVIDER: 'openai',
    FORGE_WORKER_REVIEW_MODEL: 'gpt-4.1',
    FORGE_WORKER_AUTHORITY_MODE: 'global',
    FORGE_PI_IMAGE: `sha256:${'a'.repeat(64)}`,
    FORGE_GIT_IMAGE: `sha256:${'b'.repeat(64)}`,
    FORGE_MODEL_API_KEY: 'private-api-key',
    ...overrides
  });
};

describe('worker deployment preflight', () => {
  it('keeps the existing session deadline by default and bounds explicit deployment overrides', () => {
    expect(configuration().deployment.globalExecution?.sessionTimeoutMs).toBe(300_000);
    expect(
      configuration({ FORGE_PI_SESSION_TIMEOUT_MS: '600000' }).deployment.globalExecution
        ?.sessionTimeoutMs
    ).toBe(600_000);
    for (const value of ['0', '1800001', 'NaN', '1000.5']) {
      expect(() => configuration({ FORGE_PI_SESSION_TIMEOUT_MS: value })).toThrow(
        'between 1000 and 1800000'
      );
    }
  });
  it('uses only explicit paired commit identity without changing repository configuration', () => {
    expect(configuration().deployment.globalExecution?.commitIdentity).toBeUndefined();
    expect(
      configuration({
        FORGE_GIT_AUTHOR_NAME: 'Forge Local',
        FORGE_GIT_AUTHOR_EMAIL: 'forge@localhost'
      }).deployment.globalExecution?.commitIdentity
    ).toEqual({ name: 'Forge Local', email: 'forge@localhost' });
    expect(() => configuration({ FORGE_GIT_AUTHOR_NAME: 'Forge Local' })).toThrow(
      'supplied together'
    );
    expect(() =>
      configuration({
        FORGE_GIT_AUTHOR_NAME: 'Forge\nLocal',
        FORGE_GIT_AUTHOR_EMAIL: 'forge@localhost'
      })
    ).toThrow('single-line');
    expect(() =>
      configuration({ FORGE_GIT_AUTHOR_NAME: ' ', FORGE_GIT_AUTHOR_EMAIL: 'forge@localhost' })
    ).toThrow('nonempty');
  });
  it('collects every check and never serializes deployment credentials or driver errors', async () => {
    const calls: string[] = [];
    const report = await inspectWorkerDeployment(configuration(), {
      repository: async () => {
        calls.push('repository');
      },
      authority: async () => {
        calls.push('authority');
        throw new Error('private-password');
      },
      temporal: async () => {
        calls.push('temporal');
      },
      image: async () => {
        calls.push('image');
      }
    });
    expect(calls).toEqual(['repository', 'authority', 'temporal', 'image', 'image']);
    expect(report.status).toBe('not-ready');
    expect(report.checks.filter((item) => item.status === 'failed')).toEqual([
      { name: 'authority', status: 'failed' }
    ]);
    expect(JSON.stringify(report)).not.toContain('private');
  });

  it('returns ready only when every probe succeeds and avoids image probes for legacy mode', async () => {
    const config = configuration();
    const imageCalls: string[] = [];
    const probes = {
      repository: async () => {},
      authority: async () => {},
      temporal: async () => {},
      image: async (image: string) => {
        imageCalls.push(image);
      }
    };
    expect((await inspectWorkerDeployment(config, probes)).status).toBe('ready');
    expect(imageCalls).toHaveLength(2);
    imageCalls.length = 0;
    expect(
      (
        await inspectWorkerDeployment(
          {
            ...config,
            mode: 'legacy',
            deployment: { ...config.deployment, globalExecution: undefined }
          },
          probes
        )
      ).status
    ).toBe('ready');
    expect(imageCalls).toEqual([]);
  });

  it('checks a real Git root without changing its HEAD or worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-preflight-'));
    try {
      execFileSync('git', ['init', directory]);
      await expect(deploymentProbes.repository(directory)).rejects.toThrow();
      await writeFile(join(directory, 'file.txt'), 'approved');
      execFileSync('git', ['-C', directory, 'add', '.']);
      execFileSync('git', [
        '-C',
        directory,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-m',
        'initial'
      ]);
      const before = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
        encoding: 'utf8'
      });
      await deploymentProbes.repository(directory);
      expect(
        execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
      ).toBe(before);
      expect(
        execFileSync('git', ['-C', directory, 'status', '--porcelain'], { encoding: 'utf8' })
      ).toBe('');
      await expect(deploymentProbes.image('mutable:latest')).rejects.toThrow('digest-pinned');
      await expect(
        deploymentProbes.authority({
          ...configuration(),
          deployment: {
            ...configuration().deployment,
            authority: { backend: 'sqlite', databasePath: join(directory, 'absent.sqlite') }
          }
        })
      ).rejects.toThrow('PostgreSQL');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('observes a real Temporal namespace and rejects an absent namespace without polling', async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    try {
      const config = configuration();
      config.temporal.serverUrl = `http://${environment.connection.options.address}`;
      await deploymentProbes.temporal(config);
      await expect(
        deploymentProbes.temporal({
          ...config,
          temporal: { ...config.temporal, namespace: 'not-registered' }
        })
      ).rejects.toThrow();
    } finally {
      await environment.teardown();
    }
  }, 30_000);
});
