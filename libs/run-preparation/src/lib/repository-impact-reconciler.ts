import type {
  ObservedTaskImpact,
  TaskImpactReconciler,
  TaskImpactReconciliationRequest,
  TaskImpactReconciliationResult,
  WritableResource,
  WorkspaceChangeInspector
} from '@ai-native-software-delivery-orchestrator/domain';
import { isWritableResourceCoveredBy } from '@ai-native-software-delivery-orchestrator/domain';

import { RepositoryResourceResolver } from './local-runtime-starter.js';

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const stableSet = (values: Iterable<string>): ReadonlySet<string> =>
  new Set([...values].toSorted(compareText));

export class RepositoryImpactReconciler implements TaskImpactReconciler {
  readonly #changes: WorkspaceChangeInspector;
  readonly #resources: RepositoryResourceResolver;

  constructor(options: {
    readonly changes: WorkspaceChangeInspector;
    readonly resources: RepositoryResourceResolver;
  }) {
    this.#changes = options.changes;
    this.#resources = options.resources;
  }

  async reconcile(
    request: TaskImpactReconciliationRequest
  ): Promise<TaskImpactReconciliationResult> {
    const changes = await this.#changes.inspect(request.workspace);
    const filesCreated = new Set<string>();
    const filesWritten = new Set<string>();
    const filesDeleted = new Set<string>();
    const resources = new Map<string, WritableResource>();
    for (const change of changes) {
      const fileId = this.#resources.fileId(change.path);
      filesWritten.add(fileId);
      resources.set(fileId, this.#resources.resolve(change.path));
      if (change.kind === 'created') {
        filesCreated.add(fileId);
      } else if (change.kind === 'deleted') {
        filesDeleted.add(fileId);
      }
    }
    const predictedFiles = request.impact.predicted.filesWritten;
    const expandedFileIds = [...filesWritten].filter((fileId) => !predictedFiles.has(fileId));
    const unleasedFileIds = [...resources]
      .flatMap(([fileId, resource]) =>
        request.leases.some(
          (lease) =>
            lease.state === 'ACTIVE' && isWritableResourceCoveredBy(lease.resource, resource)
        )
          ? []
          : [fileId]
      )
      .toSorted(compareText);
    const status =
      unleasedFileIds.length > 0
        ? 'unleased-change'
        : expandedFileIds.length > 0
          ? 'runtime-scope-expanded'
          : 'within-predicted-scope';
    const reported = request.reportedImpact;
    const observed: ObservedTaskImpact = {
      taskId: request.taskId,
      filesRead: reported?.filesRead ?? new Set(),
      filesCreated: stableSet(filesCreated),
      filesWritten: stableSet(filesWritten),
      filesDeleted: stableSet(filesDeleted),
      symbolsWritten: reported?.symbolsWritten ?? new Set(),
      dependencyRequests: reported?.dependencyRequests ?? new Set(),
      manifestFilesChanged: reported?.manifestFilesChanged ?? new Set(),
      generatedFilesChanged: reported?.generatedFilesChanged ?? new Set()
    };
    return {
      observed,
      reconciliation: {
        status,
        expandedFileIds: stableSet(expandedFileIds),
        unleasedFileIds: stableSet(unleasedFileIds)
      }
    };
  }
}
