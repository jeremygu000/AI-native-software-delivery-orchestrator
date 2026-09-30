import { randomUUID } from 'node:crypto';

import {
  FencedMutationPort,
  taskLeasePlanFingerprint,
  type AgentExecutionAttempt,
  type CurrentMutationTokenRequest,
  type GlobalMutationAuthority,
  type GlobalMutationLease,
  type PersistedTaskExecutionBinding,
  type TaskRepairAttempt,
  type WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';

export interface AdmittedGlobalMutation {
  readonly mutation: {
    readonly port: FencedMutationPort;
    readonly claim: Omit<CurrentMutationTokenRequest, 'resource'>;
  };
  readonly leases: readonly GlobalMutationLease[];
  /** The only supported callback entry for a controlled mutation in this admission. */
  execute<T>(resource: WritableResource, sideEffect: () => Promise<T>): Promise<T>;
}

export type GlobalAdmissionResult =
  | { readonly status: 'granted'; readonly admission: AdmittedGlobalMutation }
  | { readonly status: 'blocked'; readonly blockers: readonly GlobalMutationLease[] };

/**
 * Admission for a persisted builder/repair attempt. The provider rechecks the
 * approved run, binding, attempt, resources and state atomically with STARTING.
 * Consumers must supply the returned mutation context to their tool runtime;
 * this class does not authorize direct Git or filesystem effects.
 */
export class GlobalBuilderRepairAdmission {
  constructor(private readonly authority: GlobalMutationAuthority) {}

  async admitBuilder(
    binding: PersistedTaskExecutionBinding,
    attempt: AgentExecutionAttempt
  ): Promise<GlobalAdmissionResult> {
    if (
      attempt.state !== 'PREPARING' ||
      binding.runId !== attempt.runId ||
      binding.taskId !== attempt.taskId ||
      binding.agentId !== attempt.agentId ||
      binding.workspace.id !== attempt.workspaceId ||
      taskLeasePlanFingerprint(binding.leasePlan) !== attempt.leasePlanFingerprint
    ) {
      throw new Error('Builder global admission requires the exact approved attempt and workspace');
    }
    return this.#admit(binding, {
      runId: attempt.runId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      agentId: attempt.agentId,
      workspaceId: attempt.workspaceId
    });
  }

  async admitRepair(
    binding: PersistedTaskExecutionBinding,
    attempt: TaskRepairAttempt
  ): Promise<GlobalAdmissionResult> {
    if (
      attempt.state !== 'PREPARING' ||
      binding.runId !== attempt.runId ||
      binding.taskId !== attempt.taskId ||
      binding.workspace.id !== attempt.workspaceId
    ) {
      throw new Error('Repair global admission requires the exact approved attempt and workspace');
    }
    return this.#admit(binding, {
      runId: attempt.runId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      agentId: attempt.agentId,
      workspaceId: attempt.workspaceId
    });
  }

  async #admit(
    binding: PersistedTaskExecutionBinding,
    owner: CurrentMutationTokenRequest['owner']
  ): Promise<GlobalAdmissionResult> {
    const scopeId = await this.authority.recoverGlobalRunScope(owner.runId);
    const claimId = randomUUID();
    const result = await this.authority.claimGlobalMutation({
      scopeId,
      claimId,
      owner,
      resources: binding.leasePlan.predictedResources
    });
    if (result.status === 'blocked') {
      return { status: 'blocked', blockers: result.blockers };
    }
    const lease = result.leases[0];
    if (
      lease === undefined ||
      result.leases.some(
        (item) =>
          item.claimId !== lease.claimId ||
          item.claimId !== claimId ||
          item.scopeId !== scopeId ||
          item.token !== result.token ||
          item.owner.runId !== owner.runId ||
          item.owner.taskId !== owner.taskId ||
          item.owner.attemptId !== owner.attemptId ||
          item.owner.agentId !== owner.agentId ||
          item.owner.workspaceId !== owner.workspaceId
      )
    ) {
      throw new Error('Granted global mutation is missing its workspace-bound durable lease');
    }
    const port = new FencedMutationPort(this.authority);
    const claim = { scopeId, claimId, owner, token: result.token };
    return {
      status: 'granted',
      admission: {
        mutation: { port, claim },
        leases: result.leases,
        execute: (resource, sideEffect) => port.execute({ ...claim, resource }, sideEffect)
      }
    };
  }
}
