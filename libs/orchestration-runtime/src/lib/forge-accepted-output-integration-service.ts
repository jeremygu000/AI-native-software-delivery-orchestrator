import type {
  OrchestrationPersistence,
  TaskCodeReviewSubject,
  TaskContract,
  TaskWorkspace,
  WorkspaceManager
} from '@ai-native-software-delivery-orchestrator/domain';

import { TaskOutputAdmissionCoordinator } from './task-output-admission-coordinator.js';

export class ForgeAcceptedOutputIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeAcceptedOutputIntegrationError';
  }
}

export type ForgeIntegrationStatus = 'integrated' | 'blocked';

export interface ForgeAcceptedOutputIntegrationResult {
  readonly status: ForgeIntegrationStatus;
  readonly workspace: TaskWorkspace;
}

type IntegrationPersistence = Pick<
  OrchestrationPersistence,
  'persistWorkspace' | 'persistIntegration'
>;

export class ForgeAcceptedOutputIntegrationService {
  readonly #coordinator: TaskOutputAdmissionCoordinator;
  readonly #workspaceManager: WorkspaceManager;
  readonly #persistence: IntegrationPersistence;

  constructor(options: {
    readonly coordinator: TaskOutputAdmissionCoordinator;
    readonly workspaceManager: WorkspaceManager;
    readonly persistence: IntegrationPersistence;
  }) {
    this.#coordinator = options.coordinator;
    this.#workspaceManager = options.workspaceManager;
    this.#persistence = options.persistence;
  }

  async integrate(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspace: TaskWorkspace;
    readonly subject: TaskCodeReviewSubject;
    readonly task: TaskContract;
  }): Promise<ForgeAcceptedOutputIntegrationResult> {
    await this.#coordinator.assertCurrentIntegrationAdmission({
      runId: request.runId,
      taskId: request.taskId,
      workspace: request.workspace,
      subject: request.subject
    });

    await this.#workspaceManager.commit({
      workspace: request.workspace,
      message: `forge: ${request.task.id}\n\nForge-Run-Id: ${request.runId}\nForge-Task-Id: ${request.task.id}`
    });

    const integration = await this.#workspaceManager.integrate(request.workspace);

    await this.#persistence.persistWorkspace({
      runId: request.runId,
      workspace: integration.workspace
    });
    await this.#persistence.persistIntegration(
      request.runId,
      integration.status,
      integration.status === 'integrated' ? request.subject.outputAttemptId : undefined
    );

    return {
      status: integration.status,
      workspace: integration.workspace
    };
  }

  async resume(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspace: TaskWorkspace;
    readonly subject: TaskCodeReviewSubject;
  }): Promise<ForgeAcceptedOutputIntegrationResult> {
    if (request.workspace.phase === 'INTEGRATED') {
      return { status: 'integrated', workspace: request.workspace };
    }
    if (request.workspace.phase !== 'INTEGRATION_BLOCKED') {
      throw new ForgeAcceptedOutputIntegrationError(
        `Workspace is not blocked for integration: ${request.workspace.id}`
      );
    }
    await this.#coordinator.assertBlockedIntegrationContinuationAdmission({
      runId: request.runId,
      taskId: request.taskId,
      workspace: request.workspace,
      subject: request.subject
    });
    const integration = await this.#workspaceManager.resumeIntegration(request.workspace);
    await this.#persistence.persistWorkspace({
      runId: request.runId,
      workspace: integration.workspace
    });
    await this.#persistence.persistIntegration(
      request.runId,
      integration.status,
      integration.status === 'integrated' ? request.subject.outputAttemptId : undefined
    );
    return { status: integration.status, workspace: integration.workspace };
  }
}
