import { AgentToolRuntime } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type {
  AgentRunRequest,
  GlobalMutationAuthority,
  OrchestrationPersistence,
  PersistedTaskExecutionBinding,
  TaskWorkspace,
  WorkspaceManager,
  WritableResource,
  WriteGuard
} from '@ai-native-software-delivery-orchestrator/domain';

import type { AdmittedGlobalMutation } from './global-builder-repair-admission.js';

/**
 * A single admitted attempt's production side-effect boundary. Callers must not
 * substitute the legacy workspace manager or optional tool mutation context.
 * This does not authorize integration, disposal, or a second workspace.
 */
export class GlobalBuilderRepairExecutionBoundary {
  constructor(
    private readonly options: {
      readonly authority: GlobalMutationAuthority;
      readonly admission: AdmittedGlobalMutation;
      readonly binding: PersistedTaskExecutionBinding;
      readonly persistence: Pick<OrchestrationPersistence, 'persistWorkspace'>;
      readonly workspaceManager: Pick<WorkspaceManager, 'create'>;
    }
  ) {
    const { claim } = options.admission.mutation;
    if (
      claim.owner.runId !== options.binding.runId ||
      claim.owner.taskId !== options.binding.taskId ||
      claim.owner.workspaceId !== options.binding.workspace.id
    ) {
      throw new Error('Global execution requires the approved workspace-bound claim');
    }
  }

  /** Git worktree/branch mutation and its durable record share one repository permit. */
  async createWorkspace(): Promise<TaskWorkspace> {
    let callbackStarted = false;
    try {
      return await this.options.admission.execute({ type: 'repository' }, async () => {
        callbackStarted = true;
        const workspace = await this.options.workspaceManager.create(
          this.options.binding.workspace
        );
        if (
          workspace.id !== this.options.binding.workspace.id ||
          workspace.runId !== this.options.binding.runId ||
          workspace.taskId !== this.options.binding.taskId ||
          workspace.workspacePath !== this.options.binding.workspace.workspacePath ||
          workspace.integrationRepositoryPath !==
            this.options.binding.workspace.integrationRepositoryPath ||
          workspace.branchName !== this.options.binding.workspace.branchName ||
          workspace.baseRef !== this.options.binding.workspace.baseRef ||
          workspace.integrationRef !== this.options.binding.workspace.integrationRef
        ) {
          throw new Error('Git workspace differs from approved binding');
        }
        await this.options.persistence.persistWorkspace({
          runId: this.options.binding.runId,
          workspace
        });
        return workspace;
      });
    } catch (error) {
      // Even a failed Git or persistence callback may have written externally.
      // A lost process cannot prove quiescence; keep this owner blocking handoff.
      if (callbackStarted) {
        const { claim } = this.options.admission.mutation;
        await this.options.authority.markMutationUncertain({
          ...claim,
          evidence: `Global workspace creation outcome unknown: ${error instanceof Error ? error.message : 'non-error rejection'}`
        });
      }
      throw error;
    }
  }

  /** No optional mutation context or fallback to a process-local lease is exposed. */
  createAgentTools(
    request: AgentRunRequest,
    options: {
      readonly persistence: OrchestrationPersistence;
      readonly writeGuard: WriteGuard;
      readonly resolveResource: (workspaceRelativePath: string) => WritableResource;
      readonly resolveFileId: (workspaceRelativePath: string) => string;
    }
  ): AgentToolRuntime {
    const { claim, port } = this.options.admission.mutation;
    if (
      request.runId !== claim.owner.runId ||
      request.taskId !== claim.owner.taskId ||
      request.attempt.id !== claim.owner.attemptId ||
      request.attempt.agentId !== claim.owner.agentId ||
      request.workspace.id !== claim.owner.workspaceId ||
      request.workspace.workspacePath !== this.options.binding.workspace.workspacePath ||
      (request.attempt.state !== 'STARTING' && request.attempt.state !== 'RUNNING')
    ) {
      throw new Error('Agent execution does not match the admitted global mutation');
    }
    return new AgentToolRuntime({
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attempt.id,
      agentId: request.attempt.agentId,
      workspaceId: request.workspace.id,
      workspacePath: request.workspace.workspacePath,
      impact: request.impact,
      initialLeases: request.leases,
      resolveResource: options.resolveResource,
      resolveFileId: options.resolveFileId,
      persistence: options.persistence,
      writeGuard: options.writeGuard,
      mutation: {
        port,
        claim,
        onMutationUncertain: async (error) => {
          await this.options.authority.markMutationUncertain({
            ...claim,
            evidence: `Global agent mutation outcome unknown: ${error instanceof Error ? error.message : 'non-error rejection'}`
          });
        }
      }
    });
  }
}
