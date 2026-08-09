import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  analyzeRepository,
  ProjectGraphError
} from '@apra-amcos-admin-coding-orchestrator/repository-analysis';

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
      ],
      projectDependencies: [
        { from: '@fixture/core', to: '@fixture/utils' },
        { from: '@fixture/web', to: '@fixture/core' },
        { from: '@fixture/web', to: '@fixture/utils' }
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
