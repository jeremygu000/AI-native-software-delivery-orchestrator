import { randomUUID } from 'node:crypto';
import { AgentToolRuntime } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import {
  FencedMutationPort,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type GlobalMutationOwner,
  type OrchestrationPersistence,
  type WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';
import { PostgresGlobalMutationAuthority } from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { forbiddenLocalGuard } from './postgres-execution-child.js';

/** Executes an already admitted repair; does not create Git workspaces, expand
 * authority, run verification scripts or enable production GLOBAL_READY startup. */
export class PostgresRepairRunner {
  constructor(
    private readonly options: {
      authority: PostgresGlobalMutationAuthority;
      persistence: OrchestrationPersistence;
      resolveResource: (path: string) => WritableResource;
      resolveFileId: (path: string) => string;
      createRunner: (tools: AgentToolRuntime) => AgentRunner;
      confirmStopped?: (request: AgentRunRequest, result: AgentRunResult) => Promise<string>;
    }
  ) {}

  async run(
    identity: { scopeId: string; claimId: string; owner: GlobalMutationOwner; token: number },
    request: AgentRunRequest
  ): Promise<{ result: AgentRunResult; claimState: 'RELEASED' | 'HELD_UNCERTAIN' }> {
    const recovered = await this.options.authority.recoverRepairExecution(identity);
    const repair = recovered.attempt;
    const workspace = recovered.workspace;
    if (
      repair.runId !== request.runId ||
      repair.taskId !== request.taskId ||
      request.task.id !== repair.taskId ||
      repair.id !== request.attempt.id ||
      repair.agentId !== request.attempt.agentId ||
      repair.workspaceId !== request.workspace.id ||
      repair.revision !== request.attempt.revision ||
      repair.state !== request.attempt.state ||
      request.attempt.leasePlanFingerprint !==
        `repair:${repair.parentReviewSubject.workspaceChangeFingerprint}` ||
      workspace.workspacePath !== request.workspace.workspacePath ||
      workspace.integrationRepositoryPath !== request.workspace.integrationRepositoryPath ||
      workspace.branchName !== request.workspace.branchName ||
      workspace.baseRef !== request.workspace.baseRef ||
      workspace.integrationRef !== request.workspace.integrationRef ||
      workspace.revision !== request.workspace.revision ||
      workspace.phase !== request.workspace.phase ||
      workspace.runId !== request.workspace.runId ||
      workspace.taskId !== request.workspace.taskId
    ) {
      throw new Error('Repair runner request differs from its admitted execution');
    }
    if (repair.state === 'RUNNING') {
      await this.options.authority.finishRepairExecution({
        ...identity,
        expectedRevision: repair.revision,
        state: 'UNKNOWN',
        detail: 'Recovered RUNNING repair requires independent session recovery'
      });
      throw new Error('Recovered RUNNING repair requires independent session recovery');
    }
    const tools = new AgentToolRuntime({
      runId: request.runId,
      taskId: request.taskId,
      attemptId: repair.id,
      agentId: repair.agentId,
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      impact: request.impact,
      persistence: this.options.persistence,
      writeGuard: forbiddenLocalGuard,
      resolveResource: this.options.resolveResource,
      resolveFileId: this.options.resolveFileId,
      mutation: {
        claim: identity,
        port: new FencedMutationPort(this.options.authority),
        onMutationUncertain: async (error) => {
          await this.options.authority.markMutationUncertain({
            ...identity,
            evidence: `Repair tool outcome uncertain: ${error instanceof Error ? error.message : 'non-error rejection'}`
          });
        }
      }
    });
    const reservation = { backend: 'forge-repair-launch-reservation', value: randomUUID() };
    const reserved = await this.options.authority.startRepairExecution({
      ...identity,
      expectedRevision: repair.revision,
      sessionRef: reservation
    });
    let revision = reserved.revision;
    let started = false;
    let result: AgentRunResult;
    try {
      result = await this.options.createRunner(tools).run({
        ...request,
        onStarted: async (session) => {
          if (session.sessionRef === undefined) {
            throw new Error('Repair requires a durable external session identity');
          }
          const running = await this.options.authority.startRepairExecution({
            ...identity,
            expectedRevision: reserved.revision,
            previousSessionRef: reservation,
            sessionRef: session.sessionRef
          });
          revision = running.revision;
          started = true;
          await request.onStarted(session);
        }
      });
    } catch (error) {
      await this.options.authority.finishRepairExecution({
        ...identity,
        expectedRevision: revision,
        state: 'UNKNOWN',
        detail: `Repair session outcome uncertain: ${error instanceof Error ? error.message : 'non-error rejection'}`
      });
      throw error;
    }
    const state =
      result.status === 'completed'
        ? started
          ? 'COMPLETED'
          : 'UNKNOWN'
        : result.status === 'cancelled'
          ? 'CANCELLED'
          : result.status === 'failed' && !started
            ? 'FAILED'
            : 'UNKNOWN';
    let stopEvidence: string | undefined;
    if (state !== 'UNKNOWN' && this.options.confirmStopped !== undefined) {
      try {
        stopEvidence = await this.options.confirmStopped(request, result);
      } catch {
        /* Failed independent confirmation retains ownership. */
      }
    }
    const detail =
      result.status === 'completed' ? 'Repair agent returned completed' : result.detail;
    const terminal = await this.options.authority
      .finishRepairExecution({
        ...identity,
        expectedRevision: revision,
        state,
        detail,
        ...(stopEvidence === undefined ? {} : { stopEvidence })
      })
      .catch(async (error) => {
        if (stopEvidence === undefined) {
          throw error;
        }
        return this.options.authority.finishRepairExecution({
          ...identity,
          expectedRevision: revision,
          state,
          detail: `${detail}; ordinary release rejected`
        });
      });
    return { result, claimState: terminal.claimState };
  }
}
