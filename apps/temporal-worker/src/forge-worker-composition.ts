import { Context } from '@temporalio/activity';
import { existsSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createForgeRuntimeComposition } from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';
import {
  PiAgentRunner,
  PiCodeReviewModelResolver,
  PiCodingAgentGateway,
  PiTaskCodeReviewer,
  type PiSessionModel
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { resolveM312ExternalSmokeConfig } from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import {
  createCodeReviewPolicy,
  type CodeReviewPolicy
} from '@ai-native-software-delivery-orchestrator/planning';
import type {
  ForgeRuntimeComposition,
  ForgeRuntimeCompositionOverrides
} from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';

export { verificationPolicyFingerprint } from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';
export type {
  ForgeRuntimeComposition as ForgeWorkerComposition,
  ForgeRuntimeCompositionOverrides as ForgeWorkerCompositionOverrides
} from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';

const waitForAcceptanceRelease = async (path: string): Promise<void> => {
  while (existsSync(path)) {
    Context.current().heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const heartbeatEvaluation = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    Context.current().heartbeat();
    timer = setInterval(() => Context.current().heartbeat(), 1_000);
    const result = await operation();
    const pausePath =
      process.env.FORGE_WORKER_COMPOSITION === 'acceptance'
        ? process.env.FORGE_ACCEPTANCE_EVALUATION_RESULT_PAUSE_PATH
        : undefined;
    if (pausePath !== undefined && existsSync(pausePath)) {
      const readyPath = process.env.FORGE_ACCEPTANCE_EVALUATION_RESULT_READY_PATH;
      if (readyPath !== undefined) {
        await writeFile(readyPath, 'ready\n');
      }
      await waitForAcceptanceRelease(pausePath);
    }
    return result;
  } catch (error) {
    if (timer !== undefined) {
      throw error;
    }
    // Focused composition tests call activities without a Temporal context.
    return operation();
  } finally {
    if (timer !== undefined) {
      clearInterval(timer);
    }
  }
};

const acceptanceOverrides = (): ForgeRuntimeCompositionOverrides => ({
  builderAgentRunner: {
    async run(request) {
      await request.onStarted({ sessionRef: { backend: 'acceptance', value: request.attempt.id } });
      await writeFile(
        join(request.workspace.workspacePath, 'src/index.ts'),
        'export const value = "completed";\n'
      );
      return {
        status: 'completed',
        sessionRef: { backend: 'acceptance', value: request.attempt.id }
      };
    }
  },
  reviewer: {
    async review() {
      const callsPath = process.env.FORGE_ACCEPTANCE_REVIEW_CALLS_PATH;
      if (callsPath !== undefined) {
        await appendFile(callsPath, 'review\n');
      }
      const pausePath = process.env.FORGE_ACCEPTANCE_EVALUATION_PAUSE_PATH;
      const readyPath = process.env.FORGE_ACCEPTANCE_EVALUATION_READY_PATH;
      if (pausePath !== undefined && existsSync(pausePath)) {
        if (readyPath !== undefined) {
          await writeFile(readyPath, 'ready\n');
        }
        await waitForAcceptanceRelease(pausePath);
      }
      return { recommendation: 'accept', summary: 'Acceptance fixture approved.', findings: [] };
    }
  },
  verifier: {
    async verify() {
      return { status: 'passed' };
    }
  }
});

export interface ForgeWorkerCompositionDeployment {
  readonly databasePath: string;
  readonly repositoryPath: string;
  readonly codeReviewPolicy: CodeReviewPolicy;
  readonly reviewModel: PiSessionModel;
}

const isDeployment = (
  value: ForgeWorkerCompositionDeployment | ForgeRuntimeCompositionOverrides
): value is ForgeWorkerCompositionDeployment => 'databasePath' in value;

const createProductionAdapters = (policy: CodeReviewPolicy, model: PiSessionModel) => {
  const gateway = new PiCodingAgentGateway(undefined, { model });
  const modelResolver = {
    resolve: (identity: CodeReviewPolicy['reviewer']['model']) => {
      if (
        identity.provider !== policy.reviewer.model.provider ||
        identity.id !== policy.reviewer.model.id
      ) {
        throw new Error('Worker review policy does not match resolved deployment model');
      }
      return model;
    }
  };
  return {
    codeReviewPolicy: policy,
    agentRunnerFactory: ({
      createTools
    }: Parameters<NonNullable<ForgeRuntimeCompositionOverrides['agentRunnerFactory']>>[0]) =>
      new PiAgentRunner({ gateway, createTools }),
    reviewerFactory: ({
      policy: reviewPolicy,
      createTools
    }: Parameters<NonNullable<ForgeRuntimeCompositionOverrides['reviewerFactory']>>[0]) =>
      new PiTaskCodeReviewer({ policy: reviewPolicy, modelResolver, createTools })
  };
};

export const createTestWorkerCompositionDeployment = (): ForgeWorkerCompositionDeployment => ({
  databasePath: ':memory:',
  repositoryPath: process.cwd(),
  codeReviewPolicy: createCodeReviewPolicy({ provider: 'test', model: 'test' }),
  reviewModel: undefined
});

const workerOverrides = (
  deployment: ForgeWorkerCompositionDeployment
): ForgeRuntimeCompositionOverrides => {
  if (process.env.FORGE_M312_EXTERNAL_SMOKE === '1') {
    const externalSmoke = resolveM312ExternalSmokeConfig();
    const model = new PiCodeReviewModelResolver().resolve({
      provider: externalSmoke.provider,
      id: externalSmoke.model
    });
    return createProductionAdapters(
      createCodeReviewPolicy({
        provider: externalSmoke.provider,
        model: externalSmoke.model
      }),
      model
    );
  }
  const mode = process.env.FORGE_WORKER_COMPOSITION;
  if (mode === undefined || mode === 'production') {
    return createProductionAdapters(deployment.codeReviewPolicy, deployment.reviewModel);
  }
  if (mode === 'acceptance') {
    return { ...acceptanceOverrides(), codeReviewPolicy: deployment.codeReviewPolicy };
  }
  throw new Error(`Unsupported FORGE_WORKER_COMPOSITION: ${mode}`);
};

/**
 * Temporal adapter around the provider-neutral Forge runtime composition.
 * Direct activity tests run without a Temporal context and receive no signal.
 */
export async function createForgeWorkerComposition(
  deploymentOrOverrides: ForgeWorkerCompositionDeployment | ForgeRuntimeCompositionOverrides = {},
  explicitOverrides: ForgeRuntimeCompositionOverrides = {}
): Promise<ForgeRuntimeComposition> {
  const deployment = isDeployment(deploymentOrOverrides)
    ? deploymentOrOverrides
    : createTestWorkerCompositionDeployment();
  const overrides = isDeployment(deploymentOrOverrides) ? explicitOverrides : deploymentOrOverrides;
  const composition = await createForgeRuntimeComposition(
    { ...workerOverrides(deployment), ...overrides },
    {
      databasePath: deployment.databasePath,
      repositoryPath: deployment.repositoryPath,
      getActivityExecutionContext: () => {
        try {
          return { cancellationSignal: Context.current().cancellationSignal };
        } catch {
          return undefined;
        }
      }
    }
  );
  return {
    ...composition,
    forgeActivities: {
      ...composition.forgeActivities,
      evaluateBuilderOutput: async (input) =>
        heartbeatEvaluation(() => composition.forgeActivities.evaluateBuilderOutput(input))
    }
  };
}
