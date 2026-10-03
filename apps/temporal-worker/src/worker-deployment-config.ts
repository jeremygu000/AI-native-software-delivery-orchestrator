import { isAbsolute } from 'node:path';
import { resolveAuthorityConfiguration } from '@ai-native-software-delivery-orchestrator/persistence';
import { resolveTemporalConfig } from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import type { ForgeWorkerCompositionDeployment } from './forge-worker-composition.js';
import { resolveWorkerReviewDeploymentConfig } from './review-deployment-config.js';

/** The normal worker and deployment preflight must interpret exactly the same configuration. */
export const resolveWorkerDeployment = (environment: NodeJS.ProcessEnv = process.env) => {
  const repositoryPath = environment.FORGE_WORKER_REPOSITORY_PATH;
  if (
    repositoryPath === undefined ||
    repositoryPath.trim().length === 0 ||
    !isAbsolute(repositoryPath)
  ) {
    throw new Error('Worker requires nonempty absolute FORGE_WORKER_REPOSITORY_PATH');
  }
  const authority = resolveAuthorityConfiguration(environment);
  const temporal = resolveTemporalConfig({
    serverUrl: environment.TEMPORAL_SERVER_URL ?? 'http://localhost:7233',
    namespace: environment.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: environment.TEMPORAL_TASK_QUEUE ?? 'forge-run'
  });
  const review = resolveWorkerReviewDeploymentConfig(environment);
  const mode = environment.FORGE_WORKER_AUTHORITY_MODE ?? 'legacy';
  if (mode !== 'legacy' && mode !== 'global') {
    throw new Error('Unsupported FORGE_WORKER_AUTHORITY_MODE');
  }
  let globalExecution: ForgeWorkerCompositionDeployment['globalExecution'];
  if (mode === 'global') {
    const image = environment.FORGE_PI_IMAGE;
    const gitImage = environment.FORGE_GIT_IMAGE;
    const apiKey = environment.FORGE_MODEL_API_KEY;
    if (authority.backend !== 'postgres') {
      throw new Error('Global worker requires PostgreSQL authority');
    }
    if (
      image === undefined ||
      gitImage === undefined ||
      apiKey === undefined ||
      apiKey.trim().length === 0 ||
      !/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(image) ||
      !/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(gitImage)
    ) {
      throw new Error(
        'Global worker requires pinned FORGE_PI_IMAGE/FORGE_GIT_IMAGE and host FORGE_MODEL_API_KEY'
      );
    }
    globalExecution = { image, gitImage, apiKey };
  }
  const deployment: ForgeWorkerCompositionDeployment = {
    authority,
    repositoryPath,
    codeReviewPolicy: review.policy,
    reviewModel: review.model,
    ...(globalExecution === undefined ? {} : { globalExecution })
  };
  return { deployment, temporal, mode } as const;
};
