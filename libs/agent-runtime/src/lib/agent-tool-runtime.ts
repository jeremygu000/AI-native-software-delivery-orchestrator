import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type {
  OrchestrationPersistence,
  TaskImpact,
  WriteGuard,
  WriteLease,
  WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class AgentToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentToolDeniedError';
  }
}

export interface AgentToolRuntimeContext {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly workspacePath: string;
  readonly resolveResource: (workspaceRelativePath: string) => WritableResource;
  readonly resolveFileId: (workspaceRelativePath: string) => string;
  readonly persistence: OrchestrationPersistence;
  readonly writeGuard: WriteGuard;
}

export type AgentToolWriteResult =
  | { readonly status: 'written'; readonly path: string }
  | { readonly status: 'blocked'; readonly leaseId: string };

export class AgentToolRuntime {
  readonly #context: AgentToolRuntimeContext;
  readonly #leasesByResource = new Map<string, WriteLease>();
  readonly #writtenFileIds = new Set<string>();

  constructor(context: AgentToolRuntimeContext) {
    this.#context = context;
  }

  async read(path: string): Promise<string> {
    return readFile(this.#resolve(path), 'utf8');
  }

  async list(path = '.'): Promise<readonly string[]> {
    const directory = this.#resolve(path, true);
    return (await readdir(directory, { withFileTypes: true }))
      .map((entry) => entry.name)
      .toSorted(compareText);
  }

  async find(path: string, text: string): Promise<readonly number[]> {
    if (text.length === 0) {
      throw new AgentToolDeniedError('Search text must not be empty');
    }
    return (await this.read(path))
      .split('\n')
      .flatMap((line, index) => (line.includes(text) ? [index + 1] : []));
  }

  async write(path: string, content: string): Promise<AgentToolWriteResult> {
    const absolutePath = this.#resolve(path);
    const workspaceRelativePath = this.#relative(absolutePath);
    const resource = this.#context.resolveResource(workspaceRelativePath);
    const resourceKey = JSON.stringify(resource);
    const existing = this.#leasesByResource.get(resourceKey);
    if (existing === undefined) {
      const acquired = await this.#context.writeGuard.acquire({
        runId: this.#context.runId,
        agentId: this.#context.agentId,
        taskId: this.#context.taskId,
        resource,
        mode: 'exclusive'
      });
      if (acquired.status === 'blocked') {
        const leaseId = acquired.conflictingLeaseIds[0];
        if (leaseId === undefined) {
          throw new AgentToolDeniedError('Write lease block is missing an owner');
        }
        return { status: 'blocked', leaseId };
      }
      this.#leasesByResource.set(resourceKey, acquired.lease);
      await this.#context.persistence.persistLease({
        runId: this.#context.runId,
        lease: acquired.lease
      });
    }
    await writeFile(absolutePath, content, 'utf8');
    this.#writtenFileIds.add(this.#context.resolveFileId(workspaceRelativePath));
    return { status: 'written', path: workspaceRelativePath };
  }

  async edit(path: string, expected: string, replacement: string): Promise<AgentToolWriteResult> {
    if (expected.length === 0) {
      throw new AgentToolDeniedError('Expected edit text must not be empty');
    }
    const content = await this.read(path);
    const index = content.indexOf(expected);
    if (index === -1) {
      throw new AgentToolDeniedError(`Expected edit text was not found: ${path}`);
    }
    if (content.indexOf(expected, index + expected.length) !== -1) {
      throw new AgentToolDeniedError(`Expected edit text is ambiguous: ${path}`);
    }
    return this.write(
      path,
      `${content.slice(0, index)}${replacement}${content.slice(index + expected.length)}`
    );
  }

  observedImpact(): TaskImpact['observed'] {
    const filesWritten = new Set([...this.#writtenFileIds].toSorted(compareText));
    return {
      taskId: this.#context.taskId,
      filesRead: new Set(),
      filesCreated: new Set(),
      filesWritten,
      filesDeleted: new Set(),
      symbolsWritten: new Set(),
      dependencyRequests: new Set(),
      manifestFilesChanged: new Set(),
      generatedFilesChanged: new Set()
    };
  }

  leases(): readonly WriteLease[] {
    return [...this.#leasesByResource.values()];
  }

  #resolve(path: string, allowWorkspaceRoot = false): string {
    const absolutePath = resolve(this.#context.workspacePath, path);
    this.#relative(absolutePath, allowWorkspaceRoot);
    return absolutePath;
  }

  #relative(absolutePath: string, allowWorkspaceRoot = false): string {
    const workspaceRelativePath = relative(this.#context.workspacePath, absolutePath);
    if (
      (!allowWorkspaceRoot && workspaceRelativePath.length === 0) ||
      workspaceRelativePath === '..' ||
      workspaceRelativePath.startsWith(`..${sep}`)
    ) {
      throw new AgentToolDeniedError('Agent tool path must stay inside the task workspace');
    }
    return workspaceRelativePath.split(sep).join('/');
  }
}
