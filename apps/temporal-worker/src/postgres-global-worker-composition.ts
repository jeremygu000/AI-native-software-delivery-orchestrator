import { randomUUID } from 'node:crypto';
import type {
  AgentExecutionAttempt,
  AgentRunRequest,
  RepositoryGraph,
  TaskCodeReviewer,
  TaskVerifier
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  PostgresGlobalMutationAuthority,
  PostgresOrchestrationPersistence
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { type PiHostModelProxy } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import {
  type ForgeRuntimeComposition,
  verificationPolicyFingerprint
} from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';
import {
  ForgeRunProgressionService,
  TaskCodeReviewCollector
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import {
  RepositoryResourceResolver,
  SnapshotTaskCodeReviewSubjectProvider,
  TaskVerificationEvidenceFactory
} from '@ai-native-software-delivery-orchestrator/run-preparation';
import {
  GitRepositorySnapshotProvider,
  GitWorkspaceManager
} from '@ai-native-software-delivery-orchestrator/workspace-git';
import { createPostgresDockerChildRunner } from './postgres-docker-child-runner.js';
import { createPostgresDockerRepairRunner } from './postgres-docker-repair-runner.js';
import { PostgresExecutionChildTools } from './postgres-execution-child.js';
import { PostgresIntegrationRunner } from './postgres-integration-runner.js';
import { DockerIntegrationGit } from './docker-integration-git.js';
import { traceForgeOperation } from './forge-telemetry.js';

/** Opt-in global activity routing. All legacy writer activities are replaced;
 * externally approved setup/handoff must already exist before builder launch. */
export const createPostgresGlobalWorkerComposition = (options: {
  authority: PostgresGlobalMutationAuthority;
  persistence: PostgresOrchestrationPersistence;
  base: ForgeRuntimeComposition;
  graph: RepositoryGraph;
  codeReviewPolicyFingerprint: string;
  reviewer: TaskCodeReviewer;
  verifier: TaskVerifier;
  image: string;
  gitImage: string;
  commitIdentity?: { name: string; email: string };
  sessionTimeoutMs?: number;
  approvedVerificationPolicyFingerprint?: string;
  modelProxy: PiHostModelProxy;
  modelIdentity?: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: string;
  };
  cancellationSignal?: () => AgentRunRequest['cancellationSignal'];
}): ForgeRuntimeComposition => {
  const { persistence, authority } = options;
  const activeVerificationFingerprint =
    options.approvedVerificationPolicyFingerprint ?? verificationPolicyFingerprint;
  const resolver = new RepositoryResourceResolver(options.graph);
  const snapshots = new GitRepositorySnapshotProvider();
  const progression = new ForgeRunProgressionService({
    persistence: new Proxy(persistence, {
      get(target, property) {
        if (property === 'updateRunState') {
          return target.updateGlobalRunState.bind(target);
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    })
  });
  const collector = new TaskCodeReviewCollector({
    reviewer: {
      review: (request) =>
        traceForgeOperation(
          'forge.review',
          {
            runId: request.runId,
            taskId: request.task.id,
            attemptId: request.builderAttempt.id
          },
          () => options.reviewer.review(request)
        )
    },
    store: persistence
  });
  const tools = new PostgresExecutionChildTools({
    authority,
    persistence,
    resolveResource: (path) => resolver.resolve(path),
    resolveFileId: (path) => resolver.fileId(path)
  });
  const builder = createPostgresDockerChildRunner({
    authority,
    tools,
    image: options.image,
    executable: '/usr/local/bin/node',
    args: ['/opt/forge/entrypoint.mjs'],
    modelProxy: options.modelProxy,
    modelIdentity: options.modelIdentity,
    timeoutMs: options.sessionTimeoutMs
  });
  const repair = createPostgresDockerRepairRunner({
    authority,
    persistence,
    image: options.image,
    executable: '/usr/local/bin/node',
    args: ['/opt/forge/entrypoint.mjs'],
    modelProxy: options.modelProxy,
    modelIdentity: options.modelIdentity,
    timeoutMs: options.sessionTimeoutMs,
    resolveResource: (path) => resolver.resolve(path),
    resolveFileId: (path) => resolver.fileId(path)
  });
  const recover = async (runId: string, taskId: string) => {
    const recovered = await persistence.recoverRun(runId);
    if (recovered === undefined || recovered.run.state !== 'ACTIVE') {
      throw new Error('Global worker requires an ACTIVE approved run');
    }
    const task = recovered.tasks.find((item) => item.id === taskId);
    const binding = recovered.taskBindings.find((item) => item.taskId === taskId);
    const workspace = recovered.workspaces.find(
      (item) => item.workspace.taskId === taskId
    )?.workspace;
    const impact =
      recovered.impacts.find((item) => item.taskId === taskId)?.impact ?? binding?.impact;
    if (
      task === undefined ||
      binding === undefined ||
      workspace === undefined ||
      impact === undefined
    ) {
      throw new Error('Global worker requires a committed task workspace and impact');
    }
    return { recovered, task, binding, workspace, impact };
  };
  const evaluate = async (
    runId: string,
    taskId: string,
    builderId: string,
    output: AgentExecutionAttempt
  ) => {
    const context = await recover(runId, taskId);
    const builderAttempt = context.recovered.attempts.find(
      (item) => item.attempt.id === builderId
    )?.attempt;
    if (
      builderAttempt === undefined ||
      output.state !== 'COMPLETED' ||
      context.recovered.run.authority?.verificationPolicyFingerprint !==
        activeVerificationFingerprint ||
      context.recovered.run.authority.codeReviewPolicyFingerprint !==
        options.codeReviewPolicyFingerprint
    ) {
      throw new Error(
        'Global evaluation requires completed approved output and verification policy'
      );
    }
    const verified = await traceForgeOperation(
      'forge.verification',
      { runId, taskId, attemptId: output.id },
      () =>
        options.verifier.verify({
          runId,
          task: context.task,
          workspace: context.workspace
        }),
      (result) => result.status
    );
    const snapshot = await snapshots.capture({ repositoryPath: context.workspace.workspacePath });
    const recordedEvidence = (await persistence.recoverVerificationEvidence(runId)).find(
      (item) => item.attemptId === output.id
    );
    if (
      recordedEvidence !== undefined &&
      (recordedEvidence.workspaceId !== context.workspace.id ||
        recordedEvidence.workspaceRevision !== context.workspace.revision ||
        recordedEvidence.workspaceChangeFingerprint !== snapshot.workingTreeFingerprint ||
        recordedEvidence.verificationPolicyFingerprint !== activeVerificationFingerprint ||
        recordedEvidence.status !== verified.status)
    ) {
      throw new Error('Verification retry differs from its immutable output evidence');
    }
    const evidence =
      recordedEvidence ??
      new TaskVerificationEvidenceFactory().create({
        id: randomUUID(),
        attempt: output,
        workspace: { ...context.workspace, workspacePath: snapshot.repositoryRoot },
        snapshot,
        verificationPolicyFingerprint: activeVerificationFingerprint,
        verifiedAt: new Date(),
        status: verified.status
      });
    await persistence.persistVerificationEvidence(evidence);
    const subject = new SnapshotTaskCodeReviewSubjectProvider().createSubject({
      builderAttempt,
      outputAttemptId: output.id,
      workspace: context.workspace,
      impact: context.impact,
      workspaceSnapshot: snapshot,
      verificationFingerprint: evidence.fingerprint
    });
    const reviews = await persistence.recoverReviews(runId);
    const recordedReview = reviews.find(
      (item) => item.taskId === taskId && JSON.stringify(item.subject) === JSON.stringify(subject)
    );
    if (recordedReview !== undefined) {
      return {
        runId,
        taskId,
        recommendation: recordedReview.review.recommendation,
        verificationId: evidence.fingerprint,
        subjectRef: {
          builderAttemptId: builderId,
          outputAttemptId: output.id,
          workspaceId: context.workspace.id
        },
        reviewId: `${taskId}:${recordedReview.iteration}`
      };
    }
    const iteration =
      Math.max(
        0,
        ...reviews.filter((item) => item.taskId === taskId).map((item) => item.iteration)
      ) + 1;
    const review = await collector.collect({
      runId,
      task: context.task,
      workspace: context.workspace,
      impact: context.impact,
      builderAttempt,
      subject,
      repository: options.graph,
      iteration,
      verificationResult: verified
    });
    return {
      runId,
      taskId,
      recommendation: review.recommendation,
      verificationId: evidence.fingerprint,
      subjectRef: {
        builderAttemptId: builderId,
        outputAttemptId: output.id,
        workspaceId: context.workspace.id
      },
      reviewId: `${taskId}:${iteration}`
    };
  };
  const integrateAcceptedOutput: ForgeRuntimeComposition['forgeActivities']['integrateAcceptedOutput'] =
    async (input) =>
      traceForgeOperation(
        'forge.integration',
        {
          runId: input.runId,
          taskId: input.taskId,
          attemptId: input.subjectRef.outputAttemptId
        },
        async () => {
          const context = await recover(input.runId, input.taskId);
          const review = (await persistence.recoverReviews(input.runId)).find(
            (item) =>
              item.taskId === input.taskId &&
              item.review.recommendation === 'accept' &&
              item.subject?.outputAttemptId === input.subjectRef.outputAttemptId &&
              item.subject.builderAttemptId === input.subjectRef.builderAttemptId &&
              item.subject.workspaceId === input.workspaceId
          );
          if (review?.subject === undefined) {
            throw new Error('Global integration requires exact accepted review');
          }
          const scopeId = await authority.recoverGlobalRunScope(input.runId);
          const admission = await authority.admitIntegrationExecution({
            scopeId,
            claimId: `integration-execution:${input.runId}:${input.taskId}:${review.iteration}`,
            reviewIteration: review.iteration,
            subject: review.subject,
            owner: {
              runId: input.runId,
              taskId: input.taskId,
              attemptId: `integration:${review.subject.outputAttemptId}`,
              agentId: 'forge-integration',
              workspaceId: context.workspace.id
            }
          });
          if (admission.status === 'blocked') {
            return { runId: input.runId, taskId: input.taskId, status: 'blocked' };
          }
          const git = new DockerIntegrationGit({
            image: options.gitImage,
            commitIdentity: options.commitIdentity,
            workspace: context.workspace
          });
          const state = await new PostgresIntegrationRunner({
            authority,
            snapshots,
            workspaceManager: new GitWorkspaceManager(git),
            confirmStopped: async () => git.confirmedStopEvidence()
          }).run(admission.execution);
          if (state !== 'RELEASED') {
            throw new Error('Integration requires independent repository recovery');
          }
          await progression.advance(input.runId, {
            type: 'verification-completed',
            taskId: input.taskId,
            state: 'INTEGRATING'
          });
          await progression.advance(input.runId, {
            type: 'workspace-integrated',
            taskId: input.taskId,
            state: 'COMPLETED'
          });
          return { runId: input.runId, taskId: input.taskId, status: 'integrated' };
        },
        (result) => result.status
      );
  return {
    close: async () => {
      await options.base.close();
      await authority.close();
    },
    forgeActivities: {
      ...options.base.forgeActivities,
      reevaluateRun: async (input) => {
        const recovered = await persistence.recoverRun(input.runId);
        if (recovered === undefined) {
          throw new Error('Missing global run');
        }
        if (recovered.run.state !== 'ACTIVE') {
          return { runId: input.runId, authorizedTasks: [] };
        }
        const authorizedTasks: { taskId: string; attemptId: string }[] = [];
        for (const { attempt } of recovered.attempts) {
          if (attempt.state !== 'STARTING' && attempt.state !== 'RUNNING') {
            continue;
          }
          const parent = await authority.recoverExecutionParent(input.runId, attempt.id);
          await authority.recoverExecutionChild(parent.scopeId, parent.parentClaimId);
          authorizedTasks.push({ taskId: attempt.taskId, attemptId: attempt.id });
        }
        return { runId: input.runId, authorizedTasks };
      },
      executeBuilder: async (input) => {
        const context = await recover(input.runId, input.taskId);
        const attempt = context.recovered.attempts.find(
          (item) => item.attempt.id === input.attemptId
        )?.attempt;
        if (attempt === undefined) {
          throw new Error('Missing global builder attempt');
        }
        const parent = await authority.recoverExecutionParent(input.runId, input.attemptId);
        const outcome = await builder.run(parent.scopeId, parent.parentClaimId, {
          runId: input.runId,
          taskId: input.taskId,
          task: context.task,
          attempt,
          workspace: context.workspace,
          impact: context.impact,
          instructions: `${context.task.goal}\n${context.task.description ?? ''}\nUse only the enabled Forge tools and workspace-relative paths. After implementing the approved changes and tests, finish with a concise summary. Forge runs the approved verification and independent review after your session. Do not search for shell tools or run verification yourself when forge_command is not enabled.`,
          commandPolicy: context.binding.commandPolicy,
          cancellationSignal: options.cancellationSignal?.(),
          onStarted: async () => {}
        });
        if (outcome.result.status !== 'completed' || outcome.claimState !== 'RELEASED') {
          throw new Error('Global builder outcome requires independent recovery');
        }
        await progression.advance(input.runId, {
          type: 'agent-completed',
          taskId: input.taskId,
          state: 'VERIFYING'
        });
        return {
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: context.workspace.id,
          attemptId: attempt.id,
          impactId: attempt.id
        };
      },
      evaluateBuilderOutput: async (input) => {
        const context = await recover(input.runId, input.taskId);
        const output = context.recovered.attempts.find(
          (item) => item.attempt.id === input.builderAttemptId
        )?.attempt;
        if (output === undefined || input.workspaceId !== context.workspace.id) {
          throw new Error('Global evaluation identity mismatch');
        }
        return evaluate(input.runId, input.taskId, input.builderAttemptId, output);
      },
      executeRepair: async (input) =>
        traceForgeOperation(
          'forge.repair',
          {
            runId: input.runId,
            taskId: input.taskId,
            attemptId: input.repairAttemptId
          },
          async () => {
            const context = await recover(input.runId, input.taskId);
            const pending = (await persistence.recoverRepairAttempts(input.runId)).find(
              (item) => item.attempt.id === input.repairAttemptId
            )?.attempt;
            const review = (await persistence.recoverReviews(input.runId)).find(
              (item) => `${item.taskId}:${item.iteration}` === input.reviewId
            );
            if (
              pending === undefined ||
              review?.subject === undefined ||
              pending.parentReviewIteration !== review.iteration ||
              pending.parentReviewSubject.builderAttemptId !== input.builderAttemptId ||
              input.workspaceId !== context.workspace.id
            ) {
              throw new Error('Global repair activity lineage mismatch');
            }
            const scopeId = await authority.recoverGlobalRunScope(input.runId);
            const owner = {
              runId: input.runId,
              taskId: input.taskId,
              attemptId: pending.id,
              agentId: pending.agentId,
              workspaceId: context.workspace.id
            };
            const claimId = `repair-execution:${pending.id}`;
            const grant = await authority.claimGlobalMutation({
              scopeId,
              claimId,
              owner,
              resources: context.binding.leasePlan.predictedResources
            });
            if (grant.status === 'blocked') {
              return {
                runId: input.runId,
                taskId: input.taskId,
                state: 'blocked',
                repairAttemptId: pending.id,
                blockerLeaseId: grant.blockers[0]?.leaseId
              };
            }
            const recovered = await authority.recoverRepairExecution({
              scopeId,
              claimId,
              owner,
              token: grant.token
            });
            if (recovered.attempt.state !== 'STARTING' && recovered.attempt.state !== 'RUNNING') {
              throw new Error('Repair is not admitted for global execution');
            }
            const attempt: AgentExecutionAttempt = {
              ...recovered.attempt,
              state: recovered.attempt.state,
              leasePlanFingerprint: `repair:${pending.parentReviewSubject.workspaceChangeFingerprint}`,
              commandPolicyFingerprint:
                context.recovered.attempts.find(
                  (item) => item.attempt.id === input.builderAttemptId
                )?.attempt.commandPolicyFingerprint ?? ''
            };
            const result = await repair.run(
              { scopeId, claimId, owner, token: grant.token },
              {
                runId: input.runId,
                taskId: input.taskId,
                task: context.task,
                attempt,
                workspace: context.workspace,
                impact: context.impact,
                instructions: `${context.task.goal}\nRepair review ${pending.parentReviewIteration}: ${review.review.summary}\nUse only enabled Forge tools and workspace-relative paths. Make the exact requested corrections, preserve all validation gates, and finish with a concise summary. Forge performs the approved verification and independent review after this session. Do not search for shell tools or run verification when forge_command is not enabled.`,
                cancellationSignal: options.cancellationSignal?.(),
                onStarted: async () => {}
              }
            );
            if (result.result.status !== 'completed' || result.claimState !== 'RELEASED') {
              return {
                runId: input.runId,
                taskId: input.taskId,
                state: 'unknown',
                repairAttemptId: pending.id,
                detail: 'Repair retained unresolved external authority'
              };
            }
            const terminal = (await persistence.recoverRepairAttempts(input.runId)).find(
              (item) => item.attempt.id === pending.id
            )?.attempt;
            if (terminal === undefined || terminal.state !== 'COMPLETED') {
              throw new Error('Missing completed global repair output');
            }
            const evaluation = await evaluate(input.runId, input.taskId, input.builderAttemptId, {
              ...attempt,
              ...terminal,
              state: 'COMPLETED',
              leasePlanFingerprint: attempt.leasePlanFingerprint,
              commandPolicyFingerprint: attempt.commandPolicyFingerprint
            });
            return { ...evaluation, state: 'completed', repairAttemptId: pending.id };
          },
          (result) => result.state
        ),
      integrateAcceptedOutput,
      resumeBlockedIntegration: integrateAcceptedOutput,
      resumeBlockedRepair: async (input) => {
        const attempt = (await persistence.recoverRepairAttempts(input.runId)).find(
          (item) => item.attempt.id === input.repairAttemptId
        )?.attempt;
        if (attempt === undefined || attempt.state !== 'PREPARING') {
          return {
            runId: input.runId,
            repairAttemptId: input.repairAttemptId,
            status: 'ignored',
            detail: 'Only a never-started blocked repair may retry admission'
          };
        }
        // A wake is only a hint. executeRepair repeats the full persisted
        // provenance/current-trust admission and may still return BLOCKED.
        return {
          runId: input.runId,
          repairAttemptId: input.repairAttemptId,
          taskId: attempt.taskId,
          status: 'resumed'
        };
      },
      finalizeRunState: async (input) => {
        if (await authority.hasUnresolvedRunAuthority(input.runId)) {
          throw new Error('Run has unresolved global mutation authority');
        }
        return { runId: input.runId, status: await progression.finalize(input.runId) };
      },
      finalizeRunCancellation: async (input) => {
        if (await authority.hasUnresolvedRunAuthority(input.runId)) {
          return { runId: input.runId, status: 'pending' };
        }
        const result = await persistence.finalizeGlobalCancellation(input.runId);
        return {
          runId: input.runId,
          status: result.state === 'CANCELLED' ? 'cancelled' : 'pending'
        };
      }
    }
  };
};
