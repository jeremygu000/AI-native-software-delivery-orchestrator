import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRunner
} from '@ai-native-software-delivery-orchestrator/domain';
import { randomUUID } from 'node:crypto';
import type { AgentToolRuntime } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import {
  PostgresGlobalMutationAuthority,
  type ExecutionChildContainer
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';

import { PostgresExecutionChildTools } from './postgres-execution-child.js';

/** Explicit global-only builder path. Never invokes the legacy builder, recreates
 * a worktree or acquires a local lease. Production startup remains disabled until
 * an isolated agent gateway and independent stop confirmer can be supplied.
 */
export class PostgresExecutionChildRunner {
  constructor(
    private readonly options: {
      readonly authority: PostgresGlobalMutationAuthority;
      readonly tools: PostgresExecutionChildTools;
      readonly createRunner: (
        tools: AgentToolRuntime,
        launch: {
          readonly reservation: string;
          readonly persistCreated: (container: ExecutionChildContainer) => Promise<void>;
        }
      ) => AgentRunner;
      /** Independent daemon control only; never implies lost host callbacks drained. */
      readonly stopRecoveredContainer?: (container: ExecutionChildContainer) => Promise<void>;
      readonly confirmStopped?: (
        request: AgentRunRequest,
        result: AgentRunResult
      ) => Promise<string>;
    }
  ) {}

  async run(
    scopeId: string,
    parentClaimId: string,
    request: AgentRunRequest
  ): Promise<{
    readonly result: AgentRunResult;
    readonly claimState: 'RELEASED' | 'HELD_UNCERTAIN';
  }> {
    const child = await this.options.authority.recoverExecutionChild(scopeId, parentClaimId);
    const tools = await this.options.tools.attach(scopeId, parentClaimId, request);
    const identity = {
      scopeId,
      parentClaimId,
      claimId: child.claimId,
      owner: child.owner,
      token: child.token
    };
    let revision = child.attemptRevision;
    if (child.attemptState === 'RUNNING') {
      // The old external session might still exist. A new worker cannot launch a
      // second one from the same durable child just because its process restarted.
      await this.options.authority.finishExecutionChild({
        ...identity,
        expectedRevision: revision,
        state: 'UNKNOWN',
        detail: 'Worker recovered a RUNNING session without independent session recovery'
      });
      // Quarantine precedes daemon control. A stopped container cannot prove the
      // previous host's tool callback completed, so ownership stays uncertain.
      const container = await this.options.authority.recoverExecutionChildContainer(identity);
      if (container !== undefined && this.options.stopRecoveredContainer !== undefined) {
        await this.options.stopRecoveredContainer(container);
      }
      throw new Error('Recovered RUNNING child requires independent session recovery');
    }
    const launchReservation = { backend: 'forge-launch-reservation', value: randomUUID() };
    const reserved = await this.options.authority.startExecutionChild({
      ...identity,
      expectedRevision: revision,
      sessionRef: launchReservation
    });
    revision = reserved.revision;
    let started = false;
    let result: AgentRunResult;
    try {
      result = await this.options
        .createRunner(tools, {
          reservation: launchReservation.value,
          persistCreated: (container) =>
            this.options.authority.persistExecutionChildContainer({
              ...identity,
              launchReservation: launchReservation.value,
              container
            })
        })
        .run({
          ...request,
          onStarted: async (startedSession) => {
            if (startedSession.sessionRef === undefined) {
              throw new Error('Global builder requires a durable external session identity');
            }
            const running = await this.options.authority.startExecutionChild({
              ...identity,
              expectedRevision: reserved.revision,
              previousSessionRef: launchReservation,
              sessionRef: startedSession.sessionRef
            });
            revision = running.revision;
            started = true;
            await request.onStarted(startedSession);
          }
        });
    } catch (error) {
      await this.options.authority.finishExecutionChild({
        ...identity,
        expectedRevision: revision,
        state: 'UNKNOWN',
        detail: `Agent outcome uncertain: ${error instanceof Error ? error.message : 'non-error rejection'}`
      });
      throw error;
    }
    // A completed result without a durable session is not a completed execution.
    const state =
      !started && result.status === 'completed'
        ? 'UNKNOWN'
        : result.status === 'completed'
          ? 'COMPLETED'
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
        // Failed independent confirmation is quarantine, never ordinary release.
      }
    }
    const detail = result.status === 'completed' ? 'Agent returned completed' : result.detail;
    const terminal = await this.options.authority
      .finishExecutionChild({
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
        // A cancellation/revocation may win after the stop observation. Record the
        // terminal outcome while retaining ownership instead of bypassing that gate.
        return this.options.authority.finishExecutionChild({
          ...identity,
          expectedRevision: revision,
          state,
          detail: `${detail}; ordinary release rejected`
        });
      });
    return { result, claimState: terminal.claimState };
  }
}
