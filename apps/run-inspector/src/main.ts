import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { resolveInspectorConfiguration } from '@ai-native-software-delivery-orchestrator/run-inspection/configuration';
import { inspectRun } from '@ai-native-software-delivery-orchestrator/run-inspection/observations';
import { createInspectorServer } from './server.js';

try {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      'deployment-env-file': { type: 'string' },
      repository: { type: 'string' },
      'task-queue': { type: 'string' },
      label: { type: 'string' },
      'operator-root': { type: 'string', default: process.cwd() },
      port: { type: 'string', default: '4777' },
      help: { type: 'boolean' }
    }
  });
  if (values.help) {
    console.log(
      'Forge Run Inspector (read-only)\nUsage: pnpm inspector --env-file <private-env> --repository <checkout> --task-queue <queue> --label <environment> [--deployment-env-file <deployment-env>] [--operator-root <root>] [--port 4777]'
    );
  } else {
    if (
      [values['env-file'], values.repository, values['task-queue'], values.label].some(
        (value) => value === undefined || value.trim() === ''
      )
    ) {
      throw new Error('Explicit environment file, repository, task queue and label are required');
    }
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('Invalid inspector port');
    }
    // Authority fields come exclusively from the selected file, never deployment/shell fallback.
    const environment = parseEnv(await readFile(resolve(values['env-file']!), 'utf8'));
    if (values['deployment-env-file'] !== undefined) {
      const deployment = parseEnv(await readFile(resolve(values['deployment-env-file']), 'utf8'));
      for (const key of ['FORGE_AUTHORITY_BACKEND', 'TEMPORAL_SERVER_URL', 'TEMPORAL_NAMESPACE']) {
        environment[key] ??= deployment[key];
      }
    }
    const configuration = await resolveInspectorConfiguration({
      environment,
      label: values.label!,
      repository: values.repository!,
      taskQueue: values['task-queue']!,
      operatorRoot: values['operator-root']
    });
    const origin = `http://127.0.0.1:${port}`;
    const server = createInspectorServer({
      environment: configuration.environment,
      origin,
      assets: resolve(import.meta.dirname, 'web'),
      inspect: (runId) => inspectRun(configuration, runId)
    });
    server.on('error', () => {
      console.error('Forge Run Inspector could not listen on the selected loopback port.');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () =>
      console.log(
        `Forge Run Inspector: ${origin}\nEnvironment: ${configuration.environment.label}\nSchema: ${configuration.environment.schema}\nQueue: ${configuration.environment.taskQueue}\nRepository: ${configuration.environment.repository}\nRead-only: no recovery or mutation controls.`
      )
    );
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => server.close());
    }
  }
} catch {
  console.error(
    'Forge Run Inspector could not start. Supply an explicit valid environment file, matching authority identity, repository, task queue and label. No fallback environment was selected.'
  );
  process.exitCode = 1;
}
