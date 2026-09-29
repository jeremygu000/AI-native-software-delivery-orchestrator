import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { DrizzleSqliteOrchestrationPersistence } from '../src/lib/drizzle-sqlite-orchestration-persistence.js';
import { SqliteGlobalMutationAuthority } from '../src/lib/sqlite-global-mutation-authority.js';

type Kind = 'builder' | 'repair' | 'integration' | 'dynamic-lease';
type Command = { kind: Kind; hold: boolean } | { kind: 'cutover'; hold: boolean };

const port = parentPort;
if (port === null) {
  throw new Error('Cutover race worker requires a parent');
}
const data: unknown = workerData;
if (
  typeof data !== 'object' ||
  data === null ||
  !('filename' in data) ||
  typeof data.filename !== 'string' ||
  !('gate' in data) ||
  !(data.gate instanceof SharedArrayBuffer)
) {
  throw new Error('Invalid cutover race worker data');
}
const { filename, gate } = data;
const signal = new Int32Array(gate);
const store = new DrizzleSqliteOrchestrationPersistence(filename);
const authority = new SqliteGlobalMutationAuthority(filename);
port.postMessage({ type: 'ready' });

const admit = async (kind: Kind): Promise<string> => {
  const runId = 'historical-B';
  switch (kind) {
    case 'builder':
      await store.persistAttempt({
        runId,
        attempt: {
          id: 'builder-attempt',
          runId,
          taskId: 'task-A',
          agentId: 'builder-agent',
          workspaceId: 'builder-workspace',
          leasePlanFingerprint: 'approved-plan',
          state: 'STARTING',
          startedAt: new Date('2026-09-29T00:00:00.000Z'),
          revision: 1
        }
      });
      return `builder:${runId}:builder-attempt`;
    case 'repair':
      await store.persistRepairAttempt({
        runId,
        attempt: {
          id: 'repair-attempt',
          runId,
          taskId: 'task-A',
          agentId: 'repair-agent',
          workspaceId: 'repair-workspace',
          parentReviewIteration: 1,
          parentReviewSubject: {
            builderAttemptId: 'builder-parent',
            outputAttemptId: 'builder-parent',
            workspaceId: 'builder-workspace',
            workspaceRevision: 1,
            workspaceChangeFingerprint: `sha256:${'a'.repeat(64)}`,
            impactFingerprint: `sha256:${'b'.repeat(64)}`,
            verificationFingerprint: `sha256:${'c'.repeat(64)}`
          },
          repairIteration: 1,
          state: 'STARTING',
          startedAt: new Date('2026-09-29T00:00:00.000Z'),
          revision: 1
        }
      });
      return `repair:${runId}:repair-attempt`;
    case 'integration':
      await store.claimIntegrationStart({
        runId,
        taskId: 'task-A',
        workspaceId: 'integration-workspace',
        outputAttemptId: 'builder-parent'
      });
      return `integration:${runId}:task-A`;
    case 'dynamic-lease': {
      const now = new Date('2026-09-29T00:00:00.000Z');
      await store.persistLease({
        runId,
        lease: {
          id: 'dynamic-lease',
          runId,
          agentId: 'builder-agent',
          taskId: 'task-A',
          resource: { type: 'file', projectId: 'project-A', fileId: 'file-A' },
          mode: 'exclusive',
          version: 1,
          state: 'ACTIVE',
          acquiredAt: now,
          lastHeartbeatAt: now
        }
      });
      return `lease:${runId}:dynamic-lease`;
    }
  }
  throw new Error('Unsupported legacy admission kind');
};

port.on('message', (command: Command) => {
  // oxlint-disable-next-line typescript/unbound-method -- The original method is invoked with its database receiver below.
  const original = Database.prototype.transaction;
  Database.prototype.transaction = function (work) {
    port.postMessage({ type: 'gate-attempt' });
    return original.call(this, (...args: unknown[]) => {
      const result = work(...args);
      if (command.hold) {
        port.postMessage({ type: 'gate-held' });
        Atomics.wait(signal, 0, 0);
      }
      return result;
    });
  } as typeof Database.prototype.transaction;
  void (async () => {
    try {
      const ownerKey =
        command.kind === 'cutover'
          ? await authority.beginLegacyCutover().then(() => undefined)
          : await admit(command.kind);
      port.postMessage({ type: 'done', ownerKey });
    } catch (error) {
      port.postMessage({ type: 'error', message: String(error) });
    } finally {
      Database.prototype.transaction = original;
    }
  })();
});
