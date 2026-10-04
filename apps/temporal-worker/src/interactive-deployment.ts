import { realpath } from 'node:fs/promises';
import { codeReviewPolicyFingerprint } from '@ai-native-software-delivery-orchestrator/planning';
import { createTemporalClient } from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import { resolveWorkerDeployment } from './worker-deployment-config.js';
import { inspectWorkerDeployment } from './worker-preflight.js';

/** Read-only operator check. Pollers indicate availability; exact policy remains authority-validated. */
export async function checkInteractiveDeployment(
  request: {
    readonly repositoryPath: string;
    readonly policyFingerprint: string;
  },
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const configuration = resolveWorkerDeployment(environment);
  if (
    (await realpath(configuration.deployment.repositoryPath)) !== request.repositoryPath ||
    codeReviewPolicyFingerprint(configuration.deployment.codeReviewPolicy) !==
      request.policyFingerprint
  ) {
    throw new Error('Worker repository or execution profile differs from the selected plan');
  }
  const report = await inspectWorkerDeployment(configuration);
  if (report.status !== 'ready') {
    throw new Error('Forge authority or worker deployment is not ready');
  }
  const handle = await createTemporalClient(configuration.temporal);
  try {
    for (const taskQueueType of [1, 2]) {
      const response = await handle.connection.withDeadline(
        Date.now() + configuration.temporal.connectTimeoutMs,
        () =>
          handle.connection.workflowService.describeTaskQueue({
            namespace: configuration.temporal.namespace,
            taskQueue: { name: configuration.temporal.taskQueue },
            taskQueueType
          })
      );
      if ((response.pollers?.length ?? 0) === 0) {
        throw new Error(
          'Forge worker is not available for this task queue. Start the worker and retry.'
        );
      }
    }
  } finally {
    await handle.close();
  }
}
