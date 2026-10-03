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
    const sessionTimeoutMs = Number(environment.FORGE_PI_SESSION_TIMEOUT_MS ?? 300_000);
    if (
      !Number.isSafeInteger(sessionTimeoutMs) ||
      sessionTimeoutMs < 1_000 ||
      sessionTimeoutMs > 1_800_000
    ) {
      throw new Error('FORGE_PI_SESSION_TIMEOUT_MS must be between 1000 and 1800000');
    }
    const name = environment.FORGE_GIT_AUTHOR_NAME;
    const email = environment.FORGE_GIT_AUTHOR_EMAIL;
    if (
      (name !== undefined || email !== undefined) &&
      (name === undefined ||
        email === undefined ||
        [name, email].some((value) => value.trim().length === 0 || /[\r\n\0]/.test(value)))
    ) {
      throw new Error(
        'FORGE_GIT_AUTHOR_NAME and FORGE_GIT_AUTHOR_EMAIL must be supplied together as nonempty single-line values'
      );
    }
    globalExecution = {
      image,
      gitImage,
      apiKey,
      sessionTimeoutMs,
      ...(name === undefined || email === undefined ? {} : { commitIdentity: { name, email } })
    };
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
