import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { API } from '@typescript/native/unstable/sync';
import { describe, expect, it, vi } from 'vitest';

import { analyzeProjectGraph, analyzeRepository } from './project-graph-analysis.js';
import { PnpmWorkspaceProvider } from './pnpm-workspace-provider.js';

const fixturePath = resolve(import.meta.dirname, '../../../../fixtures/pnpm-workspace');
const repositoryPath = resolve(import.meta.dirname, '../../../..');

const createWorkspace = async (
  workspaceYaml: string,
  packages: Readonly<Record<string, unknown>>
): Promise<string> => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'coding-orchestrator-pnpm-'));
  await writeFile(join(workspacePath, 'pnpm-workspace.yaml'), workspaceYaml);
  await writeFile(
    join(workspacePath, 'package.json'),
    JSON.stringify({ name: '@fixture/temporary-root', private: true })
  );
  for (const [packagePath, manifest] of Object.entries(packages)) {
    const directory = join(workspacePath, packagePath);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
  }
  return workspacePath;
};

describe('PnpmWorkspaceProvider', () => {
  it('detects pnpm workspaces', async () => {
    const provider = new PnpmWorkspaceProvider();

    await expect(provider.supports(fixturePath)).resolves.toBe(true);
    await expect(provider.supports(tmpdir())).resolves.toBe(false);
  });

  it('builds a deterministic project graph from a pnpm workspace', async () => {
    const provider = new PnpmWorkspaceProvider();

    const graph = await provider.analyze({ repositoryPath: fixturePath });

    expect([...graph.projects.values()]).toEqual([
      { id: '@fixture/root', name: '@fixture/root', root: '.' },
      {
        id: '@fixture/web',
        name: '@fixture/web',
        root: 'apps/web',
        sourceRoot: 'apps/web/src'
      },
      {
        id: '@fixture/core',
        name: '@fixture/core',
        root: 'packages/core',
        sourceRoot: 'packages/core/src'
      },
      {
        id: '@fixture/utils',
        name: '@fixture/utils',
        root: 'packages/utils',
        sourceRoot: 'packages/utils/src'
      }
    ]);
    expect(graph.projects.has('@fixture/ignored')).toBe(false);
    expect(graph.projectDependencies).toEqual([
      { from: '@fixture/core', to: '@fixture/utils' },
      { from: '@fixture/web', to: '@fixture/core' },
      { from: '@fixture/web', to: '@fixture/utils' }
    ]);
    expect(graph.files.size).toBe(0);
    expect(graph.symbols.size).toBe(0);
  });

  it('selects the pnpm provider through the provider-neutral entry point', async () => {
    const result = await analyzeProjectGraph(fixturePath);

    expect(result.providerId).toBe('pnpm-workspace');
    expect(result.graph.projects.size).toBe(4);
  });

  it('enriches the project graph with TypeScript files, symbols, and semantic dependencies', async () => {
    const result = await analyzeRepository(fixturePath);
    const graph = result.graph;

    expect([...graph.files.values()].map((file) => file.path)).toEqual([
      'apps/web/src/index.ts',
      'packages/core/src/index.ts',
      'packages/utils/src/index.ts'
    ]);
    expect(graph.fileDependencies).toEqual([
      {
        from: '@fixture/core:packages/core/src/index.ts',
        to: '@fixture/utils:packages/utils/src/index.ts'
      },
      {
        from: '@fixture/web:apps/web/src/index.ts',
        to: '@fixture/core:packages/core/src/index.ts'
      }
    ]);
    expect(graph.projectDependencies).toContainEqual({
      from: '@fixture/web',
      to: '@fixture/core'
    });
    expect([...graph.symbols.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'execute', kind: 'variable', exported: true }),
        expect.objectContaining({ path: 'CoreService', kind: 'class', exported: true }),
        expect.objectContaining({ path: 'CoreService.label', kind: 'property', exported: true }),
        expect.objectContaining({ path: 'CoreService.run', kind: 'method', exported: true }),
        expect.objectContaining({ path: 'ValueFormatter', kind: 'interface', exported: true }),
        expect.objectContaining({ path: 'ValueFormatter.format', kind: 'method', exported: true }),
        expect.objectContaining({ path: 'formatValue', kind: 'variable', exported: true })
      ])
    );
    expect(graph.symbolReferences).toContainEqual({
      from: '@fixture/core:packages/core/src/index.ts:CoreService.run',
      to: '@fixture/utils:packages/utils/src/index.ts:formatValue'
    });
  });

  it('indexes the supported TypeScript declaration forms and export visibility', async () => {
    const workspacePath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/consumer': { name: '@fixture/consumer' },
      'packages/model': { name: '@fixture/model' }
    });
    const packagePath = join(workspacePath, 'packages/model');
    const consumerPath = join(workspacePath, 'packages/consumer');
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await mkdir(join(packagePath, 'src/generated'), { recursive: true });
    await mkdir(join(consumerPath, 'src'), { recursive: true });
    await writeFile(
      join(workspacePath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          target: 'es2022'
        },
        include: ['src/**/*.ts', 'packages/**/*.ts']
      })
    );
    await writeFile(join(workspacePath, 'src/root.ts'), "export const rootValue = 'root';\n");
    await writeFile(
      join(packagePath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          target: 'es2022'
        },
        include: ['src/**/*.ts']
      })
    );
    await writeFile(
      join(packagePath, 'src/index.ts'),
      `import 'unresolved-external-package';
import type { Identifier as SelfIdentifier } from './index.js';
export type Identifier = string;
export enum Mode { Active = 'active' }
export namespace Labels { export const active = 'Active'; }
export namespace Labels {
  export function format(value: string): string { return value; }
  export class Token {}
}
export namespace Outer.Inner { export const nested = true; }
export interface Contract {
  readonly name: string;
  get displayName(): string;
  set displayName(value: string);
  execute(): void;
}
export class Service implements Contract {
  private secret = 'hidden';
  protected internal = 'guarded';
  readonly name = 'service';
  constructor() {}
  get displayName(): string { return this.name; }
  set displayName(_value: string) {}
  execute(): void { void this.secret; void this.internal; }
  static {}
}
export default function (): Mode { return Mode.Active; }
export class Merged { fromClass = true; }
export namespace Merged { export const fromNamespace = true; }
export namespace ReverseMerged { export const fromNamespace = true; }
export class ReverseMerged { fromClass = true; }
const dynamicKey = 'runtime-name';
export class ComputedNames {
  ordinary = true;
  [dynamicKey] = true;
  ['literal.key'] = true;
}
export class ComputedAccessors {
  get [dynamicKey](): string { return 'value'; }
  set [dynamicKey](_value: string) {}
}
export class ParenthesizedComputed {
  [(dynamicKey)] = true;
}
function overloaded(value: string): string;
function overloaded(value: number): number;
function overloaded(value: string | number): string | number { return value; }
export { overloaded };
const { ignored } = { ignored: true };
void ignored;
const selfValue: SelfIdentifier = 'self';
void selfValue;
`
    );
    await writeFile(
      join(packagePath, 'src/generated/model.generated.ts'),
      "export const generatedValue = 'generated';\n"
    );
    await writeFile(
      join(consumerPath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          target: 'es2022'
        },
        include: ['src/**/*.ts']
      })
    );
    await writeFile(
      join(consumerPath, 'src/index.ts'),
      "import type { Identifier } from '../../model/src/index.js';\nexport const id: Identifier = 'id';\n"
    );

    const graph = (await analyzeRepository(workspacePath)).graph;
    expect([...graph.files.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'packages/model/src/index.ts', isGenerated: false }),
        expect.objectContaining({
          path: 'packages/model/src/generated/model.generated.ts',
          isGenerated: true
        })
      ])
    );
    expect([...graph.symbols.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Identifier', kind: 'type', exported: true }),
        expect.objectContaining({ path: 'Mode', kind: 'enum', exported: true }),
        expect.objectContaining({ path: 'Labels', kind: 'namespace', exported: true }),
        expect.objectContaining({ path: 'Labels.active', kind: 'variable', exported: true }),
        expect.objectContaining({ path: 'Labels.format', kind: 'function', exported: true }),
        expect.objectContaining({ path: 'Labels.Token', kind: 'class', exported: true }),
        expect.objectContaining({ path: 'Outer.Inner.nested', kind: 'variable', exported: true }),
        expect.objectContaining({ path: 'Contract.name', kind: 'property', exported: true }),
        expect.objectContaining({ path: 'Contract.displayName', kind: 'method', exported: true }),
        expect.objectContaining({
          path: 'Service.constructor',
          kind: 'constructor',
          exported: true
        }),
        expect.objectContaining({ path: 'Service.secret', exported: false }),
        expect.objectContaining({ path: 'Service.internal', exported: false }),
        expect.objectContaining({ path: 'default', kind: 'function', exported: true }),
        expect.objectContaining({ path: 'overloaded', kind: 'function', exported: true }),
        expect.objectContaining({
          path: 'Merged',
          kind: 'class',
          mergedKinds: ['class', 'namespace']
        }),
        expect.objectContaining({
          path: 'ReverseMerged',
          kind: 'class',
          mergedKinds: ['class', 'namespace']
        }),
        expect.objectContaining({ path: 'Merged.fromNamespace', exported: true }),
        expect.objectContaining({ path: 'ReverseMerged.fromClass', exported: true }),
        expect.objectContaining({
          name: '<computed:dynamicKey>#1',
          path: 'ComputedNames.<computed%3AdynamicKey>#1'
        }),
        expect.objectContaining({
          name: 'literal.key',
          path: 'ComputedNames.literal%2Ekey'
        }),
        expect.objectContaining({
          name: '<computed:dynamicKey>',
          path: 'ComputedAccessors.<computed%3AdynamicKey>'
        }),
        expect.objectContaining({
          name: '<computed:dynamicKey>#1',
          path: 'ParenthesizedComputed.<computed%3AdynamicKey>#1'
        })
      ])
    );
    expect(
      [...graph.symbols.values()].filter(
        (symbol) => symbol.path === 'ComputedAccessors.<computed%3AdynamicKey>'
      )
    ).toHaveLength(1);
    expect(graph.projectDependencies).toContainEqual({
      from: '@fixture/consumer',
      to: '@fixture/model'
    });
  });

  it('resolves path aliases, multi-hop re-exports, and export-star dependencies', async () => {
    const workspacePath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/model': { name: '@fixture/model' }
    });
    const packagePath = join(workspacePath, 'packages/model');
    await mkdir(join(packagePath, 'src'), { recursive: true });
    await writeFile(
      join(packagePath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          paths: { '@model/*': ['./src/*'] },
          strict: true,
          target: 'es2022'
        },
        include: ['src/**/*.ts']
      })
    );
    await writeFile(
      join(packagePath, 'src/original.ts'),
      "const originalValue = 'original';\nexport { originalValue };\n"
    );
    await writeFile(
      join(packagePath, 'src/hop.ts'),
      "export { originalValue } from '@model/original.js';\n"
    );
    await writeFile(join(packagePath, 'src/barrel.ts'), "export * from './hop.js';\n");
    await writeFile(
      join(packagePath, 'src/consumer.ts'),
      "import { originalValue } from '@model/barrel.js';\nexport const observed = originalValue;\n"
    );

    const graph = (await analyzeRepository(workspacePath)).graph;
    const fileDependencies = graph.fileDependencies.map((edge) => ({
      from: graph.files.get(edge.from)?.path,
      to: graph.files.get(edge.to)?.path
    }));

    expect(fileDependencies).toEqual(
      expect.arrayContaining([
        {
          from: 'packages/model/src/hop.ts',
          to: 'packages/model/src/original.ts'
        },
        { from: 'packages/model/src/barrel.ts', to: 'packages/model/src/hop.ts' },
        { from: 'packages/model/src/consumer.ts', to: 'packages/model/src/barrel.ts' }
      ])
    );
    expect(graph.symbolReferences).toContainEqual({
      from: '@fixture/model:packages/model/src/consumer.ts:observed',
      to: '@fixture/model:packages/model/src/original.ts:originalValue'
    });
    expect(
      graph.symbols.get('@fixture/model:packages/model/src/original.ts:originalValue')
    ).toEqual(expect.objectContaining({ exported: true }));
  });

  it('resolves a workspace package imported through a bare package specifier', async () => {
    const workspacePath = await createWorkspace("packages:\n  - 'apps/*'\n  - 'packages/*'\n", {
      'apps/web': {
        name: '@fixture/web',
        dependencies: { '@fixture/core': 'workspace:*' }
      },
      'packages/core': {
        name: '@fixture/core',
        exports: { '.': './src/index.ts' }
      }
    });
    const webPath = join(workspacePath, 'apps/web');
    const corePath = join(workspacePath, 'packages/core');
    await mkdir(join(webPath, 'src'), { recursive: true });
    await mkdir(join(corePath, 'src'), { recursive: true });
    const config = JSON.stringify({
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        target: 'es2022'
      },
      include: ['src/**/*.ts']
    });
    await writeFile(join(webPath, 'tsconfig.json'), config);
    await writeFile(join(corePath, 'tsconfig.json'), config);
    await writeFile(join(corePath, 'src/index.ts'), "export const coreValue = 'core';\n");
    await writeFile(
      join(webPath, 'src/index.ts'),
      "import { coreValue } from '@fixture/core';\nexport const webValue = coreValue;\n"
    );
    await mkdir(join(webPath, 'node_modules/@fixture'), { recursive: true });
    await symlink(corePath, join(webPath, 'node_modules/@fixture/core'), 'dir');

    const graph = (await analyzeRepository(workspacePath)).graph;

    expect(graph.fileDependencies).toContainEqual({
      from: '@fixture/web:apps/web/src/index.ts',
      to: '@fixture/core:packages/core/src/index.ts'
    });
    expect(graph.symbolReferences).toContainEqual({
      from: '@fixture/web:apps/web/src/index.ts:webValue',
      to: '@fixture/core:packages/core/src/index.ts:coreValue'
    });
  });

  it('does not assign files from a project that has no owning TypeScript configuration', async () => {
    const workspacePath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/a': { name: '@fixture/a' },
      'packages/b': { name: '@fixture/b' },
      'packages/shared': { name: '@fixture/shared' }
    });
    const config = JSON.stringify({
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        target: 'es2022'
      },
      include: ['src/**/*.ts']
    });
    for (const packageName of ['a', 'b']) {
      const packagePath = join(workspacePath, `packages/${packageName}`);
      await mkdir(join(packagePath, 'src'), { recursive: true });
      await writeFile(join(packagePath, 'tsconfig.json'), config);
      await writeFile(
        join(packagePath, 'src/index.ts'),
        "import { sharedValue } from '../../shared/src/index.js';\nexport const value = sharedValue;\n"
      );
    }
    const sharedPath = join(workspacePath, 'packages/shared/src');
    await mkdir(sharedPath, { recursive: true });
    await writeFile(join(sharedPath, 'index.ts'), "export const sharedValue = 'shared';\n");

    const graph = (await analyzeRepository(workspacePath)).graph;

    expect([...graph.files.values()].map((file) => file.path)).not.toContain(
      'packages/shared/src/index.ts'
    );
    expect([...graph.symbols.values()].map((symbol) => symbol.name)).not.toContain('sharedValue');
  });

  it('follows solution-style TypeScript project references to source configurations', async () => {
    const workspacePath = await createWorkspace('{}\n', {});
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await writeFile(
      join(workspacePath, 'tsconfig.json'),
      `{
        // Solution configuration with JSONC syntax.
        "files": [],
        "references": [{ "path": "./tsconfig.lib.json" }],
      }`
    );
    await writeFile(
      join(workspacePath, 'tsconfig.lib.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          target: 'es2022'
        },
        include: ['src/**/*.ts']
      })
    );
    await writeFile(join(workspacePath, 'src/index.ts'), "export const value = 'value';\n");

    const graph = (await analyzeRepository(workspacePath)).graph;

    expect([...graph.files.values()].map((file) => file.path)).toEqual(['src/index.ts']);
    expect([...graph.symbols.values()]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'value', exported: true })])
    );
    expect(graph.diagnostics).toEqual([]);
  });

  it('owns a referenced TypeScript configuration stored below its project root', async () => {
    const workspacePath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/a': { name: '@fixture/a' }
    });
    const packagePath = join(workspacePath, 'packages/a');
    await mkdir(join(packagePath, 'config'), { recursive: true });
    await mkdir(join(packagePath, 'src'), { recursive: true });
    await writeFile(
      join(packagePath, 'tsconfig.json'),
      JSON.stringify({ files: [], references: [{ path: './config/tsconfig.build.json' }] })
    );
    await writeFile(
      join(packagePath, 'config/tsconfig.build.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          target: 'es2022'
        },
        include: ['../src/**/*.ts']
      })
    );
    await writeFile(join(packagePath, 'src/index.ts'), "export const value = 'value';\n");

    const graph = (await analyzeRepository(workspacePath)).graph;

    expect([...graph.files.values()].map((file) => file.path)).toEqual(['packages/a/src/index.ts']);
    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: 'MISSING_TYPESCRIPT_CONFIGURATION',
        projectId: '@fixture/temporary-root'
      })
    ]);
  });

  it('diagnoses TypeScript files not covered by any discovered configuration', async () => {
    const workspacePath = await createWorkspace('{}\n', {});
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await writeFile(
      join(workspacePath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          target: 'es2022'
        },
        files: ['src/index.ts']
      })
    );
    await writeFile(join(workspacePath, 'src/index.ts'), 'export const indexed = true;\n');
    await writeFile(join(workspacePath, 'src/uncovered.ts'), 'export const uncovered = true;\n');

    const graph = (await analyzeRepository(workspacePath)).graph;

    expect([...graph.files.values()].map((file) => file.path)).toEqual(['src/index.ts']);
    expect(graph.diagnostics).toEqual([
      {
        code: 'UNCOVERED_TYPESCRIPT_FILES',
        severity: 'warning',
        projectId: '@fixture/temporary-root',
        message:
          'Project @fixture/temporary-root has 1 TypeScript file(s) not covered by a discovered configuration',
        configPaths: ['tsconfig.json'],
        filePaths: ['src/uncovered.ts']
      }
    ]);
  });

  it('collapses TypeScript file symlinks to one real file and symbol identity', async () => {
    const workspacePath = await createWorkspace('{}\n', {});
    const sourcePath = join(workspacePath, 'src');
    await mkdir(sourcePath, { recursive: true });
    await writeFile(
      join(workspacePath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          target: 'es2022'
        },
        include: ['src/**/*.ts']
      })
    );
    await writeFile(join(sourcePath, 'index.ts'), 'export const value = true;\n');
    await symlink('index.ts', join(sourcePath, 'index-link.ts'), 'file');

    const graph = (await analyzeRepository(workspacePath)).graph;

    expect([...graph.files.values()].map((file) => file.path)).toEqual(['src/index.ts']);
    expect([...graph.symbols.values()].filter((symbol) => symbol.name === 'value')).toHaveLength(1);
  });

  it('does not index a TypeScript symlink whose real target is outside the repository', async () => {
    const workspacePath = await createWorkspace('{}\n', {});
    const outsidePath = await mkdtemp(join(tmpdir(), 'coding-orchestrator-outside-'));
    const sourcePath = join(workspacePath, 'src');
    await mkdir(sourcePath, { recursive: true });
    await writeFile(
      join(workspacePath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          target: 'es2022'
        },
        include: ['src/**/*.ts']
      })
    );
    const outsideFile = join(outsidePath, 'outside.ts');
    await writeFile(outsideFile, 'export const outside = true;\n');
    await symlink(outsideFile, join(sourcePath, 'external.ts'), 'file');

    const graph = (await analyzeRepository(workspacePath)).graph;

    expect(graph.files.size).toBe(0);
    expect(graph.symbols.size).toBe(0);
  });

  it('rejects malformed and missing TypeScript project-reference configurations', async () => {
    const malformedPath = await createWorkspace('{}\n', {});
    await writeFile(join(malformedPath, 'tsconfig.json'), '{ this is not valid json');
    await expect(analyzeRepository(malformedPath)).rejects.toMatchObject({
      code: 'INVALID_TYPESCRIPT_CONFIGURATION'
    });

    const missingReferencePath = await createWorkspace('{}\n', {});
    await writeFile(
      join(missingReferencePath, 'tsconfig.json'),
      JSON.stringify({ files: [], references: [{ path: './missing' }] })
    );
    await expect(analyzeRepository(missingReferencePath)).rejects.toMatchObject({
      code: 'INVALID_TYPESCRIPT_CONFIGURATION'
    });
  });

  it('disposes the native snapshot and closes the API after an in-session failure', async () => {
    const workspacePath = await createWorkspace('{}\n', {});
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await writeFile(
      join(workspacePath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'not-a-real-module-kind' },
        include: ['src/**/*.ts']
      })
    );
    await writeFile(join(workspacePath, 'src/index.ts'), 'export const value = true;\n');

    let snapshotDisposed = false;
    let apiClosed = false;
    const updateSnapshot = Reflect.get(API.prototype, 'updateSnapshot');
    const close = Reflect.get(API.prototype, 'close');
    const updateSnapshotSpy = vi
      .spyOn(API.prototype, 'updateSnapshot')
      .mockImplementation(function (this: API, options) {
        const snapshot = updateSnapshot.call(this, options);
        const dispose = snapshot.dispose.bind(snapshot);
        vi.spyOn(snapshot, 'dispose').mockImplementation(() => {
          snapshotDisposed = true;
          dispose();
        });
        return snapshot;
      });
    const closeSpy = vi.spyOn(API.prototype, 'close').mockImplementation(function (this: API) {
      apiClosed = true;
      close.call(this);
    });

    try {
      await expect(analyzeRepository(workspacePath)).rejects.toMatchObject({
        code: 'INVALID_TYPESCRIPT_CONFIGURATION'
      });
      expect(snapshotDisposed).toBe(true);
      expect(apiClosed).toBe(true);
    } finally {
      updateSnapshotSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('analyzes this solution-style repository instead of returning an empty graph', async () => {
    const graph = (await analyzeRepository(repositoryPath)).graph;

    expect([...graph.files.values()].map((file) => file.path)).toContain(
      'libs/repository-analysis/src/lib/typescript-repository-analyzer.ts'
    );
    expect(graph.symbols.size).toBeGreaterThan(0);
  });

  it('leaves repositories without a TypeScript configuration at project granularity', async () => {
    const workspacePath = await createWorkspace('{}\n', {});

    const graph = (await analyzeRepository(workspacePath)).graph;

    expect(graph.projects.size).toBe(1);
    expect(graph.files.size).toBe(0);
    expect(graph.symbols.size).toBe(0);
  });

  it('rejects a missing workspace dependency', async () => {
    const workspacePath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/app': {
        name: '@fixture/app',
        dependencies: { '@fixture/missing': 'workspace:*' }
      }
    });

    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: workspacePath })
    ).rejects.toMatchObject({
      code: 'INVALID_PROJECT_DEPENDENCY'
    });
  });

  it('rejects duplicate package names', async () => {
    const workspacePath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/a': { name: '@fixture/duplicate' },
      'packages/b': { name: '@fixture/duplicate' }
    });

    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: workspacePath })
    ).rejects.toMatchObject({
      code: 'DUPLICATE_PROJECT_ID'
    });
  });

  it('rejects malformed workspace configuration and manifests', async () => {
    const invalidWorkspacePath = await createWorkspace('packages: invalid\n', {});
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: invalidWorkspacePath })
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_CONFIGURATION' });

    const invalidManifestPath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/unnamed': { private: true }
    });
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: invalidManifestPath })
    ).rejects.toMatchObject({ code: 'INVALID_PACKAGE_MANIFEST' });
  });

  it('rejects invalid YAML, manifest JSON, dependency maps, and dependency versions', async () => {
    const invalidYamlPath = await createWorkspace('packages: [\n', {});
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: invalidYamlPath })
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_CONFIGURATION' });

    const invalidJsonPath = await createWorkspace("packages:\n  - 'packages/*'\n", {});
    await mkdir(join(invalidJsonPath, 'packages/broken'), { recursive: true });
    await writeFile(join(invalidJsonPath, 'packages/broken/package.json'), '{');
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: invalidJsonPath })
    ).rejects.toMatchObject({ code: 'INVALID_PACKAGE_MANIFEST' });

    const invalidDependenciesPath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/app': { name: '@fixture/app', dependencies: [] }
    });
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: invalidDependenciesPath })
    ).rejects.toMatchObject({ code: 'INVALID_PACKAGE_MANIFEST' });

    const invalidVersionPath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/app': { name: '@fixture/app', dependencies: { broken: 1 } }
    });
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: invalidVersionPath })
    ).rejects.toMatchObject({ code: 'INVALID_PACKAGE_MANIFEST' });
  });

  it('includes a root-only workspace and rejects self dependencies', async () => {
    const rootOnlyPath = await createWorkspace('{}\n', {});
    const graph = await new PnpmWorkspaceProvider().analyze({ repositoryPath: rootOnlyPath });
    expect([...graph.projects.keys()]).toEqual(['@fixture/temporary-root']);

    const selfDependencyPath = await createWorkspace("packages:\n  - 'packages/*'\n", {
      'packages/app': {
        name: '@fixture/app',
        dependencies: { '@fixture/app': 'workspace:*' }
      }
    });
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: selfDependencyPath })
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_DEPENDENCY' });
  });

  it('reports unsupported and invalid repositories with structured errors', async () => {
    await expect(analyzeProjectGraph(tmpdir())).rejects.toMatchObject({
      code: 'UNSUPPORTED_REPOSITORY'
    });
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: join(tmpdir(), 'missing-repository') })
    ).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });

    const filePath = join(await mkdtemp(join(tmpdir(), 'coding-orchestrator-file-')), 'file.txt');
    await writeFile(filePath, 'not a repository');
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: filePath })
    ).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });

    const noWorkspacePath = await mkdtemp(join(tmpdir(), 'coding-orchestrator-no-workspace-'));
    await expect(
      new PnpmWorkspaceProvider().analyze({ repositoryPath: noWorkspacePath })
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_CONFIGURATION' });
  });
});
