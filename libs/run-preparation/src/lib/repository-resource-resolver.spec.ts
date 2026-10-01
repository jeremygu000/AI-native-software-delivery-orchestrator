import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { RepositoryResourceResolver } from './repository-resource-resolver.js';

const project = (id: string, root: string) => ({
  id,
  name: id,
  root,
  packageJsonPath: `${root}/package.json`,
  dependencies: [],
  scripts: {},
  sourceRoots: [root],
  tsconfigPaths: []
});

const graph: RepositoryGraph = {
  repositoryPath: '/repository',
  projects: new Map([
    ['root', project('root', '.')],
    ['parent', project('parent', 'packages')],
    ['child', project('child', 'packages/child/')]
  ]),
  projectDependencies: [],
  files: new Map([
    [
      'published-id',
      {
        id: 'published-id',
        projectId: 'child',
        path: 'packages/child/existing.ts',
        isGenerated: false
      }
    ]
  ]),
  symbols: new Map(),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

describe('RepositoryResourceResolver', () => {
  it('preserves indexed file identities and selects the deepest approved project for new files', () => {
    const resolver = new RepositoryResourceResolver(graph);
    expect(resolver.resolve('packages/child/existing.ts')).toEqual({
      type: 'file',
      projectId: 'child',
      fileId: 'published-id'
    });
    expect(resolver.resolve('packages/child/new.ts')).toEqual({
      type: 'file',
      projectId: 'child',
      fileId: 'child:packages/child/new.ts'
    });
    expect(resolver.fileId('packages/other.ts')).toBe('parent:packages/other.ts');
    expect(resolver.resolve('outside.ts')).toMatchObject({ projectId: 'root' });
  });

  it('rejects paths outside all approved project roots instead of assigning an arbitrary project', () => {
    const resolver = new RepositoryResourceResolver({
      ...graph,
      projects: new Map([['child', project('child', 'packages/child')]])
    });
    expect(() => resolver.resolve('packages/children/escape.ts')).toThrow(
      'Workspace path does not belong to an approved project'
    );
    expect(resolver.resolve('packages/child')).toMatchObject({ projectId: 'child' });
  });
});
