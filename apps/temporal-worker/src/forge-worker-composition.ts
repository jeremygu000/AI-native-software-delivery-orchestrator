import { Context } from '@temporalio/activity';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { appendFile, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

import { createForgeRuntimeComposition } from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';
import {
  PiAgentRunner,
  ApprovedPiHostModelProxy,
  PiCodeReviewModelResolver,
  PiCodingAgentGateway,
  PiTaskCodeReviewer,
  type PiSessionModel
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { analyzeRepository } from '@ai-native-software-delivery-orchestrator/repository-analysis';
import {
  PostgresGlobalMutationAuthority,
  PostgresOrchestrationPersistence
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { SandboxedPackageScriptVerifier } from '@ai-native-software-delivery-orchestrator/run-preparation';
import { verificationPolicy } from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';
import { resolveVerificationPolicy } from '@ai-native-software-delivery-orchestrator/run-preparation';
import { createPostgresGlobalWorkerComposition } from './postgres-global-worker-composition.js';
import { resolveM312ExternalSmokeConfig } from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import {
  openAuthorityPersistence,
  type AuthorityConfiguration
} from '@ai-native-software-delivery-orchestrator/persistence';
import {
  createCodeReviewPolicy,
  fingerprintPlanValue,
  codeReviewPolicyFingerprint,
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
    await new Promise((done) => setTimeout(done, 25));
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
  readonly authority: AuthorityConfiguration;
  readonly repositoryPath: string;
  readonly codeReviewPolicy: CodeReviewPolicy;
  readonly reviewModel: PiSessionModel;
  /** Explicit opt-in. No recovery/signing-service credentials enter this worker. */
  readonly globalExecution?: {
    readonly image: string;
    readonly gitImage: string;
    readonly commitIdentity?: { name: string; email: string };
    readonly apiKey: string;
    readonly execution?: import('@ai-native-software-delivery-orchestrator/agent-runtime').ResolvedSubscriptionExecution;
    readonly sessionTimeoutMs?: number;
  };
}

const isDeployment = (
  value: ForgeWorkerCompositionDeployment | ForgeRuntimeCompositionOverrides
): value is ForgeWorkerCompositionDeployment => 'authority' in value;

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
  authority: { backend: 'sqlite', databasePath: ':memory:' },
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
  const persistence =
    overrides.persistence ?? (await openAuthorityPersistence(deployment.authority));
  let composition: ForgeRuntimeComposition;
  try {
    if (deployment.globalExecution !== undefined) {
      if (
        deployment.authority.backend !== 'postgres' ||
        !(persistence instanceof PostgresOrchestrationPersistence) ||
        process.env.FORGE_WORKER_COMPOSITION === 'acceptance' ||
        Object.keys(overrides).length !== 0 ||
        deployment.reviewModel === undefined
      ) {
        throw new Error(
          'Global worker requires PostgreSQL and explicit production-only deployment'
        );
      }
      await persistence.assertGlobalWorkerCompositionAllowed();
      const graph = (await analyzeRepository(deployment.repositoryPath)).graph;
      const activeVerificationPolicy = resolveVerificationPolicy(verificationPolicy, process.env);
      const activeVerificationPolicyFingerprint = fingerprintPlanValue(activeVerificationPolicy);
      const proxy = new ApprovedPiHostModelProxy({
        model: deployment.reviewModel,
        apiKey: deployment.globalExecution.apiKey,
        ...(deployment.globalExecution.execution === undefined
          ? {}
          : { execution: deployment.globalExecution.execution }),
        ...(deployment.reviewModel.provider === 'deepseek' && deployment.reviewModel.reasoning
          ? { reasoning: 'high' as const }
          : {})
      });
      const base = await createForgeRuntimeComposition(
        {
          persistence,
          repositoryGraph: graph,
          codeReviewPolicy: deployment.codeReviewPolicy,
          reviewer: {
            review: async () => {
              throw new Error('Legacy review is disabled in global composition');
            }
          }
        },
        {
          repositoryPath: deployment.repositoryPath,
          approvedVerificationPolicyFingerprint: activeVerificationPolicyFingerprint
        }
      );
      let authority: PostgresGlobalMutationAuthority | undefined;
      try {
        authority = await PostgresGlobalMutationAuthority.connect(deployment.authority);
        composition = createPostgresGlobalWorkerComposition({
          authority,
          persistence,
          base,
          graph,
          codeReviewPolicyFingerprint: codeReviewPolicyFingerprint(deployment.codeReviewPolicy),
          image: deployment.globalExecution.image,
          gitImage: deployment.globalExecution.gitImage,
          commitIdentity: deployment.globalExecution.commitIdentity,
          sessionTimeoutMs: deployment.globalExecution.sessionTimeoutMs,
          modelProxy: proxy,
          verifier: new SandboxedPackageScriptVerifier({
            policy: activeVerificationPolicy,
            graph
          }),
          approvedVerificationPolicyFingerprint: activeVerificationPolicyFingerprint,
          reviewer: {
            review: async (request) => {
              // Review inference has no code loader, command executor or write tools.
              const diff = await promisify(execFile)(
                'git',
                [
                  '-C',
                  request.workspace.workspacePath,
                  'diff',
                  '--no-ext-diff',
                  '--no-textconv',
                  'HEAD',
                  '--'
                ],
                { encoding: 'utf8', maxBuffer: 1024 * 1024 }
              );
              const untracked = await promisify(execFile)(
                'git',
                [
                  '-C',
                  request.workspace.workspacePath,
                  'ls-files',
                  '--others',
                  '--exclude-standard',
                  '-z'
                ],
                { encoding: 'utf8', maxBuffer: 1024 * 1024 }
              );
              const root = await realpath(request.workspace.workspacePath);
              const addedFiles: { path: string; content: string }[] = [];
              let remaining = 1024 * 1024;
              for (const path of untracked.stdout.split('\0').filter(Boolean)) {
                const absolute = await realpath(resolve(root, path));
                const within = relative(root, absolute);
                if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
                  throw new Error('Review file escapes the approved workspace');
                }
                const contents = await readFile(absolute);
                remaining -= contents.byteLength;
                if (remaining < 0 || contents.includes(0)) {
                  throw new Error('Untracked review evidence exceeds text limits');
                }
                addedFiles.push({ path, content: contents.toString('utf8') });
              }
              const response = await proxy.complete(
                {
                  tools: [],
                  messages: [
                    {
                      role: 'user',
                      timestamp: Date.now(),
                      content: `Return only a JSON code review with recommendation accept|repair|reject, summary and findings (id,severity critical|high|medium|low,fileIds,symbolIds,description,optional requirementReference). Accept requires findings []. Repair or reject requires at least one finding. Every fileId MUST exactly equal an entry in allowedFileIds below, not a path or newly created file; report a new-file test defect against its existing approved implementation file. Use symbolIds [] unless an exact supplied symbol ID is necessary. A failed verification gate forbids accept: diagnose it against the actual diff and return actionable repair findings on known file IDs, or reject if it cannot be repaired within the approved task. Do not bypass or weaken verification.\n${JSON.stringify({ task: request.task, subject: request.subject, verificationResult: request.verificationResult, diff: diff.stdout, addedFiles, allowedFileIds: [...request.repository.files.keys()], files: [...request.repository.files.values()] })}`
                    }
                  ]
                },
                [],
                new AbortController().signal
              );
              return response.content
                .filter((item) => item.type === 'text')
                .map((item) => item.text)
                .join('');
            }
          },
          cancellationSignal: () => {
            try {
              return Context.current().cancellationSignal;
            } catch {
              return undefined;
            }
          }
        });
      } catch (error) {
        await authority?.close();
        await base.close();
        throw error;
      }
    } else {
      if (
        deployment.codeReviewPolicy.reviewer.model.executionTarget?.providerKind === 'subscription'
      ) {
        throw new Error('Subscription execution requires the isolated global worker composition');
      }
      if (overrides.persistence === undefined) {
        if (
          !('assertLegacyWorkerCompositionAllowed' in persistence) ||
          typeof persistence.assertLegacyWorkerCompositionAllowed !== 'function'
        ) {
          throw new Error('Legacy worker composition requires an authority mode check');
        }
        await persistence.assertLegacyWorkerCompositionAllowed();
      }
      composition = await createForgeRuntimeComposition(
        { ...workerOverrides(deployment), ...overrides, persistence },
        {
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
    }
  } catch (error) {
    if (overrides.persistence === undefined) {
      await persistence.close?.();
    }
    throw error;
  }
  return {
    ...composition,
    forgeActivities: {
      ...composition.forgeActivities,
      evaluateBuilderOutput: async (input) =>
        heartbeatEvaluation(() => composition.forgeActivities.evaluateBuilderOutput(input))
    }
  };
}
