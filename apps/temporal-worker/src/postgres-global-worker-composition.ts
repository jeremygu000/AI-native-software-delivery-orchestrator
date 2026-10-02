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
  modelProxy: PiHostModelProxy;
  cancellationSignal?: () => AgentRunRequest['cancellationSignal'];
}): ForgeRuntimeComposition => {
  const { persistence, authority } = options;
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
  const collector = new TaskCodeReviewCollector({ reviewer: options.reviewer, store: persistence });
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
    modelProxy: options.modelProxy
  });
  const repair = createPostgresDockerRepairRunner({
    authority,
    persistence,
    image: options.image,
    executable: '/usr/local/bin/node',
    args: ['/opt/forge/entrypoint.mjs'],
    modelProxy: options.modelProxy,
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
    const impact = recovered.impacts.find((item) => item.taskId === taskId)?.impact;
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
        verificationPolicyFingerprint ||
      context.recovered.run.authority.codeReviewPolicyFingerprint !==
        options.codeReviewPolicyFingerprint
    ) {
      throw new Error(
        'Global evaluation requires completed approved output and verification policy'
      );
    }
    const verified = await options.verifier.verify({
      runId,
      task: context.task,
      workspace: context.workspace
    });
    if (verified.status !== 'passed') {
      throw new Error('Approved read-only verification failed');
    }
    const snapshot = await snapshots.capture({ repositoryPath: context.workspace.workspacePath });
    const evidence = new TaskVerificationEvidenceFactory().create({
      id: randomUUID(),
      attempt: output,
      workspace: { ...context.workspace, workspacePath: snapshot.repositoryRoot },
      snapshot,
      verificationPolicyFingerprint,
      verifiedAt: new Date()
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
      iteration
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
  return {
    close: async () => {
      await options.base.close();
      await authority.close();
    },
    forgeActivities: {
      ...options.base.forgeActivities,
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
          instructions: `${context.task.goal}\n${context.task.description ?? ''}`,
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
      executeRepair: async (input) => {
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
            context.recovered.attempts.find((item) => item.attempt.id === input.builderAttemptId)
              ?.attempt.commandPolicyFingerprint ?? ''
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
            instructions: `${context.task.goal}\nRepair review ${pending.parentReviewIteration}: ${review.review.summary}`,
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
      integrateAcceptedOutput: async (input) => {
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
          claimId: `integration-execution:${input.taskId}:${review.iteration}`,
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
      resumeBlockedIntegration: async () => {
        throw new Error('Global blocked Git requires independent recovery');
      },
      resumeBlockedRepair: async () => {
        throw new Error('Global blocked repair requires a new approved dispatch');
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
