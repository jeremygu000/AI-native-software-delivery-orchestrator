import { AgentToolRuntime } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { FencedMutationPort } from '@ai-native-software-delivery-orchestrator/domain';
import type {
  AgentRunRequest,
  OrchestrationPersistence,
  WritableResource,
  WriteGuard
} from '@ai-native-software-delivery-orchestrator/domain';
import { PostgresGlobalMutationAuthority } from '@ai-native-software-delivery-orchestrator/postgres-persistence';

export const forbiddenLocalGuard: WriteGuard = {
  acquire: async () => {
    throw new Error('A global child cannot acquire a local write lease');
  },
  heartbeat: async () => {
    throw new Error('A global child cannot heartbeat a local write lease');
  },
  markStale: async () => {
    throw new Error('A global child cannot mark a local write lease stale');
  },
  release: async () => {
    throw new Error('A global child cannot release a local write lease');
  }
};

/**
 * Only the already-committed execution child can supply tool mutation authority.
 * This boundary does not start Pi, create Git worktrees, issue new claims, or
 * authorize repair, integration, dynamic expansion or local lease fallbacks.
 */
export class PostgresExecutionChildTools {
  constructor(
    private readonly options: {
      readonly authority: PostgresGlobalMutationAuthority;
      readonly persistence: OrchestrationPersistence;
      readonly resolveResource: (workspaceRelativePath: string) => WritableResource;
      readonly resolveFileId: (workspaceRelativePath: string) => string;
    }
  ) {}

  async attach(
    scopeId: string,
    parentClaimId: string,
    request: AgentRunRequest
  ): Promise<AgentToolRuntime> {
    const child = await this.options.authority.recoverExecutionChild(scopeId, parentClaimId);
    if (
      child.owner.runId !== request.runId ||
      child.owner.taskId !== request.taskId ||
      child.owner.attemptId !== request.attempt.id ||
      child.owner.agentId !== request.attempt.agentId ||
      child.owner.workspaceId !== request.workspace.id ||
      child.attemptRevision !== request.attempt.revision ||
      child.attemptState !== request.attempt.state ||
      child.leasePlanFingerprint !== request.attempt.leasePlanFingerprint ||
      request.task.id !== request.taskId ||
      child.workspace.runId !== request.workspace.runId ||
      child.workspace.taskId !== request.workspace.taskId ||
      child.workspace.workspacePath !== request.workspace.workspacePath ||
      child.workspace.integrationRepositoryPath !== request.workspace.integrationRepositoryPath ||
      child.workspace.branchName !== request.workspace.branchName ||
      child.workspace.baseRef !== request.workspace.baseRef ||
      child.workspace.integrationRef !== request.workspace.integrationRef ||
      child.workspace.revision !== request.workspace.revision ||
      child.workspace.phase !== request.workspace.phase
    ) {
      throw new Error('Execution child is not bound to the requested agent attempt');
    }
    const claim = {
      scopeId: child.scopeId,
      claimId: child.claimId,
      token: child.token,
      owner: child.owner
    };
    return new AgentToolRuntime({
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attempt.id,
      agentId: request.attempt.agentId,
      workspaceId: request.workspace.id,
      workspacePath: request.workspace.workspacePath,
      impact: request.impact,
      initialLeases: request.leases,
      resolveResource: this.options.resolveResource,
      resolveFileId: this.options.resolveFileId,
      persistence: this.options.persistence,
      writeGuard: forbiddenLocalGuard,
      mutation: {
        claim,
        resolveClaim: async (resource) => {
          const result = await this.options.authority.claimExecutionResource({
            ...claim,
            resource
          });
          if (result.status === 'blocked') {
            throw new Error('Approved dynamic resource is blocked by another owner');
          }
          const lease = result.leases[0];
          if (lease === undefined) {
            throw new Error('Dynamic resource grant has no lease');
          }
          return { ...claim, claimId: lease.claimId, token: result.token };
        },
        port: new FencedMutationPort(this.options.authority),
        onMutationUncertain: async (error) => {
          await this.options.authority.markMutationUncertain({
            ...claim,
            evidence: `Execution child tool callback uncertain: ${error instanceof Error ? error.message : 'non-error rejection'}`
          });
        }
      }
    });
  }
}
