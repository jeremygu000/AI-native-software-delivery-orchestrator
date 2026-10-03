import {
  DockerPiSessionGateway,
  PiAgentRunner,
  type PiHostModelProxy
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type { PostgresGlobalMutationAuthority } from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { PostgresExecutionChildRunner } from './postgres-execution-child-runner.js';
import type { PostgresExecutionChildTools } from './postgres-execution-child.js';
import { context } from '@opentelemetry/api';
import { traceForgeModelRequest } from './forge-telemetry.js';

/** Explicit global builder composition. Recovery stops the registered container
 * only after quarantine; it never proves old host callbacks drained or releases
 * authority. Ordinary production startup remains disabled.
 */
export const createPostgresDockerChildRunner = (options: {
  readonly authority: PostgresGlobalMutationAuthority;
  readonly tools: PostgresExecutionChildTools;
  readonly image: string;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly dockerExecutable?: string;
  readonly timeoutMs?: number;
  readonly modelProxy: PiHostModelProxy;
  readonly modelIdentity?: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: string;
  };
}): PostgresExecutionChildRunner => {
  const recoveryGateway = new DockerPiSessionGateway(options);
  const gateways = new Map<string, DockerPiSessionGateway>();
  return new PostgresExecutionChildRunner({
    authority: options.authority,
    tools: options.tools,
    stopRecoveredContainer: (container) => recoveryGateway.stopPersistedContainer(container),
    createRunner: (tools, launch) => {
      let traceIdentity: { runId: string; taskId: string; attemptId: string } | undefined;
      let parent = context.active();
      const gateway = new DockerPiSessionGateway({
        ...options,
        modelProxy: {
          complete: (modelContext, enabledTools, signal) =>
            options.modelIdentity === undefined || traceIdentity === undefined
              ? options.modelProxy.complete(modelContext, enabledTools, signal)
              : traceForgeModelRequest(
                  { ...options.modelIdentity, ...traceIdentity, role: 'builder' },
                  () => options.modelProxy.complete(modelContext, enabledTools, signal),
                  parent
                )
        },
        launchReservation: launch.reservation,
        persistCreated: launch.persistCreated
      });
      const runner = new PiAgentRunner({
        gateway,
        createTools: () => tools
      });
      return {
        run: async (request) => {
          traceIdentity = {
            runId: request.runId,
            taskId: request.taskId,
            attemptId: request.attempt.id
          };
          parent = context.active();
          const key = JSON.stringify([request.runId, request.attempt.id]);
          if (gateways.has(key)) {
            throw new Error('Builder gateway already owns this attempt');
          }
          gateways.set(key, gateway);
          return runner.run(request);
        }
      };
    },
    confirmStopped: async (request) => {
      const key = JSON.stringify([request.runId, request.attempt.id]);
      const gateway = gateways.get(key);
      if (gateway === undefined) {
        throw new Error('Missing isolated builder gateway');
      }
      const evidence = gateway.confirmedStopEvidence();
      gateways.delete(key);
      return evidence;
    }
  });
};
