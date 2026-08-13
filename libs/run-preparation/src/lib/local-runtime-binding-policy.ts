import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  taskLeasePlanFromPredictedImpact,
  taskConflictSchema,
  type AgentCommandPolicy,
  type PredictedTaskImpact,
  type RunAuthorityEvidence,
  type HardTaskConflict,
  type RiskTaskConflict
} from '@ai-native-software-delivery-orchestrator/domain';
import type {
  RuntimeTaskBinding,
  StartRuntimeRunRequest
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import type { PlanExecutionIntent } from '@ai-native-software-delivery-orchestrator/planning';

import type { IntegrationCheckout, RuntimeBindingPolicy } from './run-preparation.js';

const identity = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);

const impactFromArtifact = (
  impact: PlanExecutionIntent['artifact']['decision']['impacts'][number]
): PredictedTaskImpact => ({
  ...impact,
  projectsRead: new Set(impact.projectsRead),
  projectsWritten: new Set(impact.projectsWritten),
  explicitProjectsWritten: new Set(impact.explicitProjectsWritten),
  filesRead: new Set(impact.filesRead),
  filesWritten: new Set(impact.filesWritten),
  explicitFilesWritten: new Set(impact.explicitFilesWritten),
  globFilesWritten: new Set(impact.globFilesWritten),
  symbolDerivedFilesWritten: new Set(impact.symbolDerivedFilesWritten),
  symbolsRead: new Set(impact.symbolsRead),
  symbolsWritten: new Set(impact.symbolsWritten),
  sharedResources: new Set(impact.sharedResources),
  downstreamProjects: new Set(impact.downstreamProjects)
});

const authorityEvidence = (intent: PlanExecutionIntent): RunAuthorityEvidence => ({
  artifactId: intent.artifact.artifactId,
  artifactRevision: intent.artifact.revision,
  approvalId: intent.approval.approvalId,
  planFingerprint: intent.artifact.planFingerprint,
  approvalFingerprint: intent.approval.approvalFingerprint,
  claimFingerprint: intent.approvalClaim.claimFingerprint,
  executionFingerprint: intent.executionFingerprint,
  repositoryRoot: intent.artifact.repository.repositoryRoot,
  baseCommit: intent.artifact.repository.baseCommit,
  workingTreeFingerprint: intent.artifact.repository.workingTreeFingerprint,
  repositoryFactsFingerprint: intent.artifact.repository.factsFingerprint,
  sharedResourcePolicyFingerprint: intent.artifact.authority.sharedResourcePolicyFingerprint,
  verificationPolicyFingerprint: intent.artifact.authority.verificationPolicyFingerprint,
  codeReviewPolicyFingerprint: intent.artifact.authority.codeReviewPolicyFingerprint
});

const hardConflict = (conflict: unknown): HardTaskConflict => {
  const parsed = taskConflictSchema.parse(conflict);
  if (parsed.severity !== 'hard') {
    throw new Error('Approved hard-conflict collection contains a risk conflict');
  }
  return parsed;
};

const riskConflict = (conflict: unknown): RiskTaskConflict => {
  const parsed = taskConflictSchema.parse(conflict);
  if (parsed.severity === 'hard') {
    throw new Error('Approved risk-conflict collection contains a hard conflict');
  }
  return parsed;
};

export interface LocalRuntimeBindingPolicyOptions {
  readonly workspaceRoot: string;
  readonly commandPolicy?: AgentCommandPolicy;
  readonly trustedCommandPath?: string;
}

export class LocalRuntimeBindingPolicy implements RuntimeBindingPolicy {
  readonly #workspaceRoot: string;
  readonly #commandPolicy: AgentCommandPolicy | undefined;
  readonly #trustedCommandPath: string | undefined;

  constructor(options: LocalRuntimeBindingPolicyOptions) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#commandPolicy = options.commandPolicy;
    this.#trustedCommandPath = options.trustedCommandPath;
  }

  async bind(request: {
    readonly intent: PlanExecutionIntent;
    readonly checkout: IntegrationCheckout;
  }): Promise<StartRuntimeRunRequest> {
    const { intent, checkout } = request;
    const impacts = new Map(
      intent.artifact.decision.impacts.map((impact) => [impact.taskId, impactFromArtifact(impact)])
    );
    const taskBindings: RuntimeTaskBinding[] = intent.artifact.decision.specification.tasks.map(
      (task) => {
        const impact = impacts.get(task.id);
        if (impact === undefined) {
          throw new Error(`Approved plan is missing impact evidence for task: ${task.id}`);
        }
        const taskIdentity = identity(task.id);
        return {
          taskId: task.id,
          agentId: `agent-${taskIdentity}`,
          leasePlan: taskLeasePlanFromPredictedImpact(impact),
          impact: { predicted: impact },
          ...(this.#commandPolicy === undefined ? {} : { commandPolicy: this.#commandPolicy }),
          ...(this.#trustedCommandPath === undefined
            ? {}
            : { trustedCommandPath: this.#trustedCommandPath }),
          workspace: {
            id: `workspace-${taskIdentity}`,
            runId: intent.runId,
            taskId: task.id,
            integrationRepositoryPath: checkout.repositoryPath,
            workspacePath: join(this.#workspaceRoot, intent.runId, 'tasks', taskIdentity),
            branchName: `forge/task/${intent.runId}/${taskIdentity}`,
            baseRef: checkout.baseCommit,
            integrationRef: checkout.integrationRef
          }
        };
      }
    );
    return {
      run: {
        id: intent.runId,
        repositoryId: intent.artifact.repository.repositoryId,
        state: 'ACTIVE',
        createdAt: intent.boundAt,
        authority: authorityEvidence(intent)
      },
      tasks: intent.artifact.decision.specification.tasks,
      hardConflicts: intent.artifact.decision.hardConflicts.map(hardConflict),
      riskConflicts: intent.artifact.decision.riskConflicts.map(riskConflict),
      scheduleOptions: intent.artifact.decision.schedule,
      taskBindings
    };
  }
}
