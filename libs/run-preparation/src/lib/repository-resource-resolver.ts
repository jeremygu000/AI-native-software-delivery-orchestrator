import { sep } from 'node:path';

import type {
  FileNode,
  RepositoryGraph,
  WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';

const portable = (path: string): string => path.split(sep).join('/');

export class RepositoryResourceResolver {
  readonly #graph: RepositoryGraph;
  readonly #filesByPath: ReadonlyMap<string, FileNode>;

  constructor(graph: RepositoryGraph) {
    this.#graph = graph;
    this.#filesByPath = new Map([...graph.files.values()].map((file) => [file.path, file]));
  }

  resolve(path: string): Extract<WritableResource, { readonly type: 'file' }> {
    const normalizedPath = portable(path);
    const file = this.#filesByPath.get(normalizedPath);
    if (file !== undefined) {
      return { type: 'file', projectId: file.projectId, fileId: file.id };
    }
    const project = [...this.#graph.projects.values()]
      .filter((candidate) => {
        const root = candidate.root === '.' ? '' : candidate.root.replace(/\/$/, '');
        return root === '' || normalizedPath === root || normalizedPath.startsWith(`${root}/`);
      })
      .toSorted((left, right) => right.root.length - left.root.length)[0];
    if (project === undefined) {
      throw new Error(`Workspace path does not belong to an approved project: ${normalizedPath}`);
    }
    return {
      type: 'file',
      projectId: project.id,
      fileId: `${project.id}:${normalizedPath}`
    };
  }

  fileId(path: string): string {
    return this.resolve(path).fileId;
  }
}
