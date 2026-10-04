import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiPlanningGateway } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { parsePlanArtifact } from '@ai-native-software-delivery-orchestrator/planning';
import { z } from 'zod';
import { createForgeProgram, planRepositoryFromSource } from './app.js';
const fake = vi.hoisted(() => ({ generate: vi.fn<PiPlanningGateway['generate']>() }));
vi.mock('@ai-native-software-delivery-orchestrator/agent-runtime', async (original) => ({
  ...(await original<object>()),
  PiPlanningGatewayAdapter: class {
    generate = fake.generate;
  }
}));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  fake.generate.mockReset();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-source-')));
  directories.push(root);
  const repo = join(root, 'repo');
  await cp(resolve(import.meta.dirname, '../../../fixtures/pnpm-workspace'), repo, {
    recursive: true
  });
  await writeFile(
    join(repo, 'packages/core/package.json'),
    JSON.stringify({
      name: '@fixture/core',
      scripts: { test: 'node --test' },
      peerDependencies: { '@fixture/utils': 'workspace:*' }
    })
  );
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'Fixture'
    ],
    { cwd: repo }
  );
  const specificationPath = join(root, 'task.md');
  await writeFile(specificationPath, 'Change one file.');
  fake.generate.mockImplementation(async ({ prompt, executeTool }) => {
    if (prompt.includes('independent semantic')) {
      return {
        sessionId: 'review',
        output: JSON.stringify({
          recommendation: 'accept',
          summary: 'Covered',
          requirements: [
            {
              requirement: 'Change one file.',
              status: 'covered',
              taskIds: ['change'],
              detail: 'Covered'
            }
          ]
        })
      };
    }
    z.object({ items: z.array(z.object({ name: z.string() })) }).parse(
      JSON.parse((await executeTool({ name: 'forge_projects' })).content)
    );
    return {
      sessionId: 'plan',
      output: JSON.stringify({
        tasks: [
          {
            id: 'change',
            title: 'Change',
            goal: 'Change safely',
            dependencies: [],
            expectedReads: [],
            expectedWrites: [],
            sharedResources: [],
            verification: [{ type: 'package-script', packageName: '@fixture/core', script: 'test' }]
          }
        ]
      })
    };
  });
  return { root, repo, specificationPath };
};
describe('File and inline planning composition', () => {
  it('uses the same planning/review/core artifacts while keeping honest source metadata', async () => {
    const { root, repo, specificationPath } = await fixture();
    const fileDirectory = join(root, 'file-plans');
    await createForgeProgram({ writeOutput: vi.fn() }).parseAsync([
      'node',
      'forge',
      'plan',
      specificationPath,
      '--repository',
      repo,
      '--semantic-review',
      '--review-provider',
      'deepseek',
      '--review-model',
      'deepseek-flash',
      '--reasoning-effort',
      'high',
      '--plan-directory',
      fileDirectory
    ]);
    const inline = await planRepositoryFromSource({
      source: { type: 'user-request', content: 'Change one file.' },
      repositoryPath: repo,
      maxAttempts: 3,
      maxConcurrency: 1,
      semanticReviewAuthorized: true,
      reviewProvider: 'deepseek',
      reviewModel: 'deepseek-flash',
      reasoningEffort: 'high',
      planDirectory: join(root, 'inline-plans')
    });
    const files = await readdir(fileDirectory, { recursive: true });
    const path = files.find((candidate) => candidate.endsWith('.json'))!;
    const file = parsePlanArtifact(JSON.parse(await readFile(join(fileDirectory, path), 'utf8')));
    expect(file.decision).toEqual(inline.decision);
    expect(file.authority.codeReviewPolicyFingerprint).toBe(
      inline.authority.codeReviewPolicyFingerprint
    );
    expect(file.repository).toEqual(inline.repository);
    expect(file.source).toEqual({
      type: 'markdown-spec',
      content: 'Change one file.',
      path: specificationPath
    });
    expect(inline.source.type).toBe('user-request');
    expect(file.planFingerprint).not.toBe(inline.planFingerprint);
    expect(fake.generate).toHaveBeenCalledTimes(4);
  });
  it('does not save an artifact or make further model calls after cancellation during planning', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const generate = fake.generate.getMockImplementation()!;
    fake.generate.mockImplementationOnce(async (request) => {
      const output = await generate(request);
      controller.abort();
      return output;
    });
    const planDirectory = join(f.root, 'cancelled-plans');
    await expect(
      planRepositoryFromSource({
        signal: controller.signal,
        source: { type: 'user-request', content: 'Change one file.' },
        repositoryPath: f.repo,
        maxAttempts: 3,
        maxConcurrency: 1,
        semanticReviewAuthorized: true,
        reviewProvider: 'deepseek',
        reviewModel: 'deepseek-flash',
        planDirectory
      })
    ).rejects.toThrow();
    expect(fake.generate).toHaveBeenCalledOnce();
    await expect(readdir(planDirectory)).rejects.toThrow();
  });
  it('rejects cancellation before analysis, model calls or artifact creation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      planRepositoryFromSource({
        signal: controller.signal,
        source: { type: 'user-request', content: 'Change' },
        repositoryPath: '/missing',
        maxAttempts: 3,
        maxConcurrency: 1,
        semanticReviewAuthorized: true,
        reviewProvider: 'deepseek',
        reviewModel: 'deepseek-flash'
      })
    ).rejects.toThrow();
    expect(fake.generate).not.toHaveBeenCalled();
  });
});
