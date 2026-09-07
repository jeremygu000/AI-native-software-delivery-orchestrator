import type {
  AgentExecutionAttempt,
  TaskContract,
  TaskImpact,
  RepairRuntimeFeedback
} from '@ai-native-software-delivery-orchestrator/domain';
import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';

import { ForgeAcceptedOutputIntegrationService } from './forge-accepted-output-integration-service.js';
import { ForgeBuilderExecutionService } from './forge-builder-execution-service.js';
import { ForgeBuilderOutputEvaluationService } from './forge-builder-output-evaluation-service.js';
import { ForgeRepairExecutionService } from './forge-repair-execution-service.js';

export interface ForgeScenarioAServices {
  readonly executeBuilder: ForgeBuilderExecutionService;
  readonly evaluateBuilderOutput: ForgeBuilderOutputEvaluationService;
  readonly executeRepair: ForgeRepairExecutionService;
  readonly integrateAcceptedOutput: ForgeAcceptedOutputIntegrationService;
}

export interface ScenarioARunResult {
  readonly builderAttemptId: string;
  readonly repairAttemptId?: string;
  readonly verificationEvidenceId: string;
  readonly reviewSubjectRef: {
    readonly builderAttemptId: string;
    readonly outputAttemptId: string;
    readonly workspaceId: string;
  };
}

export class ForgeScenarioAServiceRunner {
  readonly #services: ForgeScenarioAServices;

  constructor(services: ForgeScenarioAServices) {
    this.#services = services;
  }

  async run(request: {
    readonly runId: string;
    readonly task: TaskContract;
    readonly binding: {
      readonly workspace: Parameters<
        ForgeBuilderExecutionService['execute']
      >[0]['binding']['workspace'];
      readonly impact?: TaskImpact;
      readonly agentId: string;
    };
    readonly attempt: AgentExecutionAttempt;
    readonly verificationPolicyFingerprint: string;
    readonly maxRepairs: number;
    readonly repository: Pick<RepositoryGraph, 'files' | 'symbols'>;
    readonly feedback?: RepairRuntimeFeedback;
  }): Promise<ScenarioARunResult> {
    const builderResult = await this.#services.executeBuilder.execute({
      runId: request.runId,
      task: request.task,
      binding: {
        workspace: request.binding.workspace,
        taskId: request.task.id,
        agentId: request.binding.agentId,
        leasePlan: {
          taskId: request.task.id,
          predictedResources: [],
          source: 'runtime-derived' as const
        }
      },
      attempt: request.attempt
    });

    const evaluationResult = await this.#services.evaluateBuilderOutput.evaluate({
      runId: request.runId,
      task: request.task,
      builderAttempt: builderResult.attempt,
      workspace: builderResult.workspace,
      impact: builderResult.impact,
      verificationPolicyFingerprint: request.verificationPolicyFingerprint,
      repository: request.repository
    });

    if (evaluationResult.recommendation === 'repair') {
      const repairResult = await this.#services.executeRepair.execute({
        runId: request.runId,
        task: request.task,
        agentId: request.binding.agentId,
        builderAttempt: builderResult.attempt,
        workspace: builderResult.workspace,
        impact: builderResult.impact,
        reviewIteration: 1,
        review: evaluationResult.review,
        subject: evaluationResult.subject,
        verificationPolicyFingerprint: request.verificationPolicyFingerprint,
        repository: request.repository,
        maxRepairs: request.maxRepairs,
        feedback: request.feedback
      });

      if (repairResult.state !== 'completed') {
        throw new Error(
          `Repair did not complete: ${repairResult.state}${'detail' in repairResult ? ` - ${repairResult.detail}` : ''}`
        );
      }

      if (repairResult.recommendation === 'repair') {
        throw new Error('Multi-repair not yet supported in Scenario A');
      }

      await this.#services.integrateAcceptedOutput.integrate({
        runId: request.runId,
        taskId: request.task.id,
        workspace: builderResult.workspace,
        subject: repairResult.reviewSubject,
        task: request.task
      });

      return {
        builderAttemptId: builderResult.attempt.id,
        repairAttemptId: repairResult.attempt.id,
        verificationEvidenceId: repairResult.verification.id,
        reviewSubjectRef: {
          builderAttemptId: repairResult.reviewSubject.builderAttemptId,
          outputAttemptId: repairResult.reviewSubject.outputAttemptId,
          workspaceId: repairResult.reviewSubject.workspaceId
        }
      };
    }

    await this.#services.integrateAcceptedOutput.integrate({
      runId: request.runId,
      taskId: request.task.id,
      workspace: builderResult.workspace,
      subject: evaluationResult.subject,
      task: request.task
    });

    return {
      builderAttemptId: builderResult.attempt.id,
      verificationEvidenceId: evaluationResult.verification.id,
      reviewSubjectRef: {
        builderAttemptId: evaluationResult.subject.builderAttemptId,
        outputAttemptId: evaluationResult.subject.outputAttemptId,
        workspaceId: evaluationResult.subject.workspaceId
      }
    };
  }
}
