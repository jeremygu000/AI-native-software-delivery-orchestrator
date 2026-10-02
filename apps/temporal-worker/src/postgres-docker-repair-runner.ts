import {
  DockerPiSessionGateway,
  PiAgentRunner,
  type PiHostModelProxy
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type {
  OrchestrationPersistence,
  WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';
import type { PostgresGlobalMutationAuthority } from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { PostgresRepairRunner } from './postgres-repair-runner.js';

/** Explicit isolated repair composition. Stopping a registered container is not
 * independent proof of host callback quiescence; no ordinary release is inferred. */
export const createPostgresDockerRepairRunner = (options: {
  readonly authority: PostgresGlobalMutationAuthority;
  readonly persistence: OrchestrationPersistence;
  readonly resolveResource: (path: string) => WritableResource;
  readonly resolveFileId: (path: string) => string;
  readonly image: string;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly dockerExecutable?: string;
  readonly timeoutMs?: number;
  readonly modelProxy: PiHostModelProxy;
}): PostgresRepairRunner => {
  const recoveryGateway = new DockerPiSessionGateway(options);
  const gateways = new Map<string, DockerPiSessionGateway>();
  return new PostgresRepairRunner({
    ...options,
    stopRecoveredContainer: (container) => recoveryGateway.stopPersistedContainer(container),
    createRunner: (tools, launch) => {
      const gateway = new DockerPiSessionGateway({
        ...options,
        launchReservation: launch.reservation,
        persistCreated: launch.persistCreated
      });
      const runner = new PiAgentRunner({
        gateway,
        createTools: () => tools
      });
      return {
        run: async (request) => {
          const key = JSON.stringify([request.runId, request.attempt.id]);
          if (gateways.has(key)) {
            throw new Error('Repair gateway already owns this attempt');
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
        throw new Error('Missing isolated repair gateway');
      }
      const evidence = gateway.confirmedStopEvidence();
      gateways.delete(key);
      return evidence;
    }
  });
};
