import { isAbsolute } from 'node:path';
import { resolveAuthorityConfiguration } from '@ai-native-software-delivery-orchestrator/persistence';

import {
  resolveTemporalConfig,
  createTemporalWorker
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';

import { createForgeWorkerComposition } from './forge-worker-composition.js';
import { resolveWorkerReviewDeploymentConfig } from './review-deployment-config.js';

async function main(): Promise<void> {
  if (
    process.env.FORGE_WORKER_REPOSITORY_PATH === undefined ||
    process.env.FORGE_WORKER_REPOSITORY_PATH.trim().length === 0 ||
    !isAbsolute(process.env.FORGE_WORKER_REPOSITORY_PATH)
  ) {
    throw new Error('Worker requires nonempty absolute FORGE_WORKER_REPOSITORY_PATH');
  }
  const authority = resolveAuthorityConfiguration(process.env);
  const config = resolveTemporalConfig({
    serverUrl: process.env.TEMPORAL_SERVER_URL ?? 'http://localhost:7233',
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'forge-run'
  });

  const review = resolveWorkerReviewDeploymentConfig();
  const globalMode = process.env.FORGE_WORKER_AUTHORITY_MODE;
  if (globalMode !== undefined && globalMode !== 'legacy' && globalMode !== 'global') {
    throw new Error('Unsupported FORGE_WORKER_AUTHORITY_MODE');
  }
  let globalExecution: { image: string; gitImage: string; apiKey: string } | undefined;
  if (globalMode === 'global') {
    const image = process.env.FORGE_PI_IMAGE;
    const gitImage = process.env.FORGE_GIT_IMAGE;
    const apiKey = process.env.FORGE_MODEL_API_KEY;
    if (
      image === undefined ||
      gitImage === undefined ||
      apiKey === undefined ||
      apiKey.length === 0 ||
      !/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(image) ||
      !/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(gitImage)
    ) {
      throw new Error(
        'Global worker requires pinned FORGE_PI_IMAGE/FORGE_GIT_IMAGE and host FORGE_MODEL_API_KEY'
      );
    }
    globalExecution = { image, gitImage, apiKey };
  }
  const composition = await createForgeWorkerComposition({
    authority,
    repositoryPath: process.env.FORGE_WORKER_REPOSITORY_PATH,
    codeReviewPolicy: review.policy,
    reviewModel: review.model,
    ...(globalExecution === undefined ? {} : { globalExecution })
  });
  const handle = await createTemporalWorker(config, {
    forgeActivities: composition.forgeActivities
  });

  const shutdown = async (): Promise<void> => {
    await handle.shutdown();
    await composition.close();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await handle.run();
}

main().catch((error: unknown) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
