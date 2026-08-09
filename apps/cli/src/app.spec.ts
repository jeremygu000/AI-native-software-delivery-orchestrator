import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  analyzeRepository,
  ProjectGraphError
} from '@ai-native-software-delivery-orchestrator/repository-analysis';

import { createForgeProgram } from './app.js';

const fixturePath = resolve(import.meta.dirname, '../../../fixtures/pnpm-workspace');

describe('forge analyze', () => {
  it('analyzes a real pnpm workspace and prints a stable project graph', async () => {
    let output = '';
    const program = createForgeProgram({
      cwd: fixturePath,
      writeOutput: (value) => {
        output += value;
      }
    });

    await program.parseAsync(['node', 'forge', 'analyze', '.']);

    const result: unknown = JSON.parse(output);
    expect(result).toEqual({
      provider: 'pnpm-workspace',
      repositoryPath: fixturePath,
      counts: {
        projects: 4,
        files: 3,
        symbols: 7,
        projectDependencies: 3,
        fileDependencies: 2,
        symbolReferences: 4,
        diagnostics: 1
      },
      projects: [
        {
          id: '@fixture/root',
          name: '@fixture/root',
          root: '.',
          packageJsonPath: 'package.json',
          dependencies: [],
          scripts: {},
          sourceRoots: [],
          tsconfigPaths: ['tsconfig.json']
        },
        {
          id: '@fixture/web',
          name: '@fixture/web',
          root: 'apps/web',
          packageJsonPath: 'apps/web/package.json',
          dependencies: [
            {
              name: '@fixture/core',
              version: 'workspace:*',
              kind: 'dependency',
              workspaceProtocol: true
            },
            {
              name: '@fixture/utils',
              version: 'workspace:^',
              kind: 'dev-dependency',
              workspaceProtocol: true
            },
            {
              name: 'external-package',
              version: '1.0.0',
              kind: 'dependency',
              workspaceProtocol: false
            }
          ],
          scripts: {},
          sourceRoots: ['apps/web/src'],
          tsconfigPaths: ['apps/web/tsconfig.json']
        },
        {
          id: '@fixture/core',
          name: '@fixture/core',
          root: 'packages/core',
          packageJsonPath: 'packages/core/package.json',
          dependencies: [
            {
              name: '@fixture/utils',
              version: 'workspace:*',
              kind: 'peer-dependency',
              workspaceProtocol: true
            }
          ],
          scripts: {},
          sourceRoots: ['packages/core/src'],
          tsconfigPaths: ['packages/core/tsconfig.json']
        },
        {
          id: '@fixture/utils',
          name: '@fixture/utils',
          root: 'packages/utils',
          packageJsonPath: 'packages/utils/package.json',
          dependencies: [],
          scripts: {},
          sourceRoots: ['packages/utils/src'],
          tsconfigPaths: ['packages/utils/tsconfig.json']
        }
      ],
      projectDependencies: [
        {
          from: '@fixture/core',
          to: '@fixture/utils',
          sources: ['package-dependency', 'typescript-import', 'workspace-protocol']
        },
        {
          from: '@fixture/web',
          to: '@fixture/core',
          sources: ['package-dependency', 'typescript-import', 'workspace-protocol']
        },
        {
          from: '@fixture/web',
          to: '@fixture/utils',
          sources: ['package-dependency', 'workspace-protocol']
        }
      ],
      diagnostics: [
        {
          code: 'EMPTY_TYPESCRIPT_PROJECT',
          severity: 'warning',
          projectId: '@fixture/root',
          message: 'Project @fixture/root produced no owned TypeScript source files',
          configPaths: ['tsconfig.json']
        }
      ]
    });
  });

  it('prints structured project graph errors', async () => {
    let errorOutput = '';
    const program = createForgeProgram({
      analyzeRepository: async () => {
        throw new ProjectGraphError('INVALID_REPOSITORY', 'Repository is unavailable');
      }
    });
    program.exitOverride();
    program.configureOutput({
      writeErr: (value) => {
        errorOutput += value;
      }
    });

    await expect(program.parseAsync(['node', 'forge', 'analyze', '.'])).rejects.toMatchObject({
      code: 'commander.error'
    });
    expect(errorOutput).toContain('INVALID_REPOSITORY: Repository is unavailable');
  });

  it('does not mask unexpected analysis errors', async () => {
    const failure = new Error('native analyzer failed');
    const program = createForgeProgram({
      analyzeRepository: async () => {
        throw failure;
      }
    });

    await expect(program.parseAsync(['node', 'forge', 'analyze', '.'])).rejects.toBe(failure);
  });

  it('prints complete graph details only when requested', async () => {
    let output = '';
    const program = createForgeProgram({
      cwd: fixturePath,
      writeOutput: (value) => {
        output += value;
      }
    });

    await program.parseAsync(['node', 'forge', 'analyze', '.', '--full']);

    const result: unknown = JSON.parse(output);
    expect(result).toEqual(
      expect.objectContaining({
        files: expect.arrayContaining([expect.objectContaining({ path: 'apps/web/src/index.ts' })]),
        symbols: expect.arrayContaining([expect.objectContaining({ path: 'CoreService.run' })]),
        fileDependencies: expect.any(Array),
        symbolReferences: expect.any(Array)
      })
    );
  });

  it('uses the process working directory and standard output by default', async () => {
    const analysis = await analyzeRepository(fixturePath);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = createForgeProgram({
      analyzeRepository: async () => analysis
    });

    try {
      await program.parseAsync(['node', 'forge', 'analyze', fixturePath]);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"provider": "pnpm-workspace"'));
    } finally {
      output.mockRestore();
    }
  });

  it('keeps planning explicitly unavailable', async () => {
    const program = createForgeProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => undefined });

    await expect(program.parseAsync(['node', 'forge', 'plan', 'tasks.yaml'])).rejects.toMatchObject(
      {
        code: 'commander.error'
      }
    );
  });
});
