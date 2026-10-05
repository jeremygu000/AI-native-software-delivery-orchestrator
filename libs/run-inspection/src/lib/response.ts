import type { ForgeRunInspection, InspectionEnvironment } from './inspection.js';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((key) => typeof value[key] === 'string');
const scalarFields = (value: unknown) =>
  record(value) &&
  Object.values(value).every(
    (field) => field === null || ['string', 'number', 'boolean'].includes(typeof field)
  );
const state = (value: unknown) =>
  typeof value === 'string' &&
  ['complete', 'active', 'pending', 'failed', 'unknown'].includes(value);
const unknownReason = (value: unknown) =>
  typeof value === 'string' &&
  [
    'no-evidence',
    'conflicting-evidence',
    'no-current-workflow',
    'source-unavailable',
    'insufficient-evidence'
  ].includes(value);
const source = (value: unknown) =>
  typeof value === 'string' &&
  [
    'PostgreSQL durable authority',
    'Temporal',
    'Git/worktree observation',
    'local operator evidence'
  ].includes(value);

export function isInspectionEnvironment(value: unknown): value is InspectionEnvironment {
  return (
    record(value) &&
    value.authorityMode === 'global' &&
    strings(value, [
      'id',
      'label',
      'database',
      'host',
      'schema',
      'role',
      'taskQueue',
      'namespace',
      'repository'
    ])
  );
}
/** Validate the presentation boundary without importing any authority/provider code into React. */
export function isRunInspection(value: unknown): value is ForgeRunInspection {
  return (
    record(value) &&
    value.version === 1 &&
    isInspectionEnvironment(value.environment) &&
    strings(value, ['runId', 'refreshedAt']) &&
    Array.isArray(value.tasks) &&
    value.tasks.every((task) => record(task) && strings(task, ['id', 'title', 'state'])) &&
    Array.isArray(value.nodes) &&
    value.nodes.every(
      (node) =>
        record(node) &&
        strings(node, ['id', 'label', 'explanation']) &&
        state(node.state) &&
        (node.state === 'unknown'
          ? node.unknownReason === undefined || unknownReason(node.unknownReason)
          : node.unknownReason === undefined) &&
        (node.taskId === undefined || typeof node.taskId === 'string') &&
        Array.isArray(node.evidence) &&
        node.evidence.every(
          (entry) =>
            record(entry) &&
            source(entry.source) &&
            typeof entry.observedAt === 'string' &&
            scalarFields(entry.fields)
        )
    ) &&
    Array.isArray(value.edges) &&
    value.edges.every((edge) => record(edge) && strings(edge, ['id', 'source', 'target'])) &&
    Array.isArray(value.sources) &&
    value.sources.every(
      (entry) =>
        record(entry) &&
        source(entry.source) &&
        strings(entry, ['observedAt', 'message']) &&
        ['observed', 'unavailable'].includes(String(entry.status))
    )
  );
}
