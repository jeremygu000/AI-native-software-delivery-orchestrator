import {
  DockerPiSessionGateway,
  PiAgentRunner,
  type PiHostModelProxy
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type { PostgresGlobalMutationAuthority } from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { PostgresExecutionChildRunner } from './postgres-execution-child-runner.js';
import type { PostgresExecutionChildTools } from './postgres-execution-child.js';

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
}): PostgresExecutionChildRunner => {
  const recoveryGateway = new DockerPiSessionGateway(options);
  return new PostgresExecutionChildRunner({
    authority: options.authority,
    tools: options.tools,
    stopRecoveredContainer: (container) => recoveryGateway.stopPersistedContainer(container),
    createRunner: (tools, launch) =>
      new PiAgentRunner({
        gateway: new DockerPiSessionGateway({
          ...options,
          launchReservation: launch.reservation,
          persistCreated: launch.persistCreated
        }),
        createTools: () => tools
      })
    // No independent stop confirmer: terminal ownership remains uncertain.
  });
};
