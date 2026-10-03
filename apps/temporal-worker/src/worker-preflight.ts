import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Connection } from '@temporalio/client';
import { authorityConfigurationFingerprint } from '@ai-native-software-delivery-orchestrator/persistence';
import {
  PostgresGlobalMutationAuthority,
  PostgresOrchestrationPersistence
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import type { resolveWorkerDeployment } from './worker-deployment-config.js';

const execute = promisify(execFile);
type Deployment = ReturnType<typeof resolveWorkerDeployment>;
type CheckName = 'repository' | 'authority' | 'temporal' | 'pi-image' | 'git-image';

export interface WorkerPreflightReport {
  readonly status: 'ready' | 'not-ready';
  readonly mode: 'legacy' | 'global';
  readonly authorityId: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly checks: readonly { readonly name: CheckName; readonly status: 'passed' | 'failed' }[];
}

/** Only observations: never construct activities, migrate, pull images, start a
 * container, poll a task queue or send a model request. Failure output is fixed
 * text: driver/provider errors can contain credentials and are not serialized. */
export async function inspectWorkerDeployment(
  configuration: Deployment,
  probes: {
    repository(path: string): Promise<void>;
    authority(configuration: Deployment): Promise<void>;
    temporal(configuration: Deployment): Promise<void>;
    image(image: string): Promise<void>;
  } = deploymentProbes
): Promise<WorkerPreflightReport> {
  const { deployment, temporal, mode } = configuration;
  const checks: { name: CheckName; status: 'passed' | 'failed' }[] = [];
  const check = async (name: CheckName, probe: () => Promise<void>) => {
    try {
      await probe();
      checks.push({ name, status: 'passed' });
    } catch {
      checks.push({ name, status: 'failed' });
    }
  };
  await check('repository', () => probes.repository(deployment.repositoryPath));
  await check('authority', () => probes.authority(configuration));
  await check('temporal', () => probes.temporal(configuration));
  if (deployment.globalExecution !== undefined) {
    const global = deployment.globalExecution;
    await check('pi-image', () => probes.image(global.image));
    await check('git-image', () => probes.image(global.gitImage));
  }
  return {
    status: checks.every((item) => item.status === 'passed') ? 'ready' : 'not-ready',
    mode,
    authorityId: authorityConfigurationFingerprint(deployment.authority),
    namespace: temporal.namespace,
    taskQueue: temporal.taskQueue,
    checks
  };
}

export const deploymentProbes = {
  async repository(path: string): Promise<void> {
    const root = await realpath(path);
    const result = await execute('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      timeout: 10_000
    });
    if ((await realpath(result.stdout.trim())) !== root) {
      throw new Error('Configured repository must be its Git root');
    }
    await execute('git', ['-C', root, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      timeout: 10_000
    });
  },
  async authority(configuration: Deployment): Promise<void> {
    const authority = configuration.deployment.authority;
    // Opening the legacy SQLite constructor creates/updates schema. Refuse that
    // operation here rather than calling a supposedly read-only preflight.
    if (authority.backend !== 'postgres') {
      throw new Error('Read-only deployment preflight requires PostgreSQL');
    }
    const persistence = await PostgresOrchestrationPersistence.connect(authority);
    try {
      if (configuration.mode === 'global') {
        await persistence.assertGlobalWorkerCompositionAllowed();
        const global = await PostgresGlobalMutationAuthority.connect(authority);
        await global.close();
      } else {
        await persistence.assertLegacyWorkerCompositionAllowed();
      }
    } finally {
      await persistence.close();
    }
  },
  async temporal(configuration: Deployment): Promise<void> {
    const url = new URL(configuration.temporal.serverUrl);
    const connection = await Connection.connect({
      address: url.host,
      connectTimeout: configuration.temporal.connectTimeoutMs
    });
    try {
      await connection.withDeadline(Date.now() + configuration.temporal.connectTimeoutMs, () =>
        connection.workflowService.describeNamespace({
          namespace: configuration.temporal.namespace
        })
      );
    } finally {
      await connection.close();
    }
  },
  async image(image: string): Promise<void> {
    if (!/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(image)) {
      throw new Error('A digest-pinned image is required');
    }
    const result = await execute('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
      timeout: 10_000
    });
    if (!/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim())) {
      throw new Error('Pinned image is unavailable');
    }
  }
};
