import {
  PiCodeReviewModelResolver,
  type PiSessionModel
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import {
  createCodeReviewPolicy,
  type CodeReviewPolicy
} from '@ai-native-software-delivery-orchestrator/planning';

export interface WorkerReviewDeploymentConfig {
  readonly policy: CodeReviewPolicy;
  readonly model: PiSessionModel;
}

export const resolveWorkerReviewDeploymentConfig = (
  environment: NodeJS.ProcessEnv = process.env,
  resolveModel: (identity: { readonly provider: string; readonly id: string }) => PiSessionModel = (
    identity
  ) => new PiCodeReviewModelResolver().resolve(identity)
): WorkerReviewDeploymentConfig => {
  const provider = environment.FORGE_WORKER_REVIEW_PROVIDER;
  const model = environment.FORGE_WORKER_REVIEW_MODEL;
  if (provider === undefined || model === undefined) {
    throw new Error('Worker requires FORGE_WORKER_REVIEW_PROVIDER and FORGE_WORKER_REVIEW_MODEL');
  }
  const policy = createCodeReviewPolicy({ provider, model });
  return {
    policy,
    model: resolveModel(policy.reviewer.model)
  };
};

export const assertWorkerReviewPolicyMatchesAuthority = (
  expectedFingerprint: string,
  actualFingerprint: string
): void => {
  if (expectedFingerprint !== actualFingerprint) {
    throw new Error('Worker review policy does not match durable run authority');
  }
};
