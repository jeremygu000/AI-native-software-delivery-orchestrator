import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';
import type { PreparedOrchestrationPlan } from '@ai-native-software-delivery-orchestrator/planning';
import { describe, expect, it, vi } from 'vitest';
import * as repositoryAnalysis from '@ai-native-software-delivery-orchestrator/repository-analysis';
import { LocalPlanStore } from './local-plan.js';
import { runLocalPlan } from './local-run.js';
import { createForgeProgram } from './app.js';
import {
  PiOutputReviewer,
  RepositoryTaskVerifier,
  type OutputReviewer
} from './task-completion.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function fixture(finalCheckFails = false) {
  const repository = await mkdtemp(join(realpathSync(tmpdir()), 'forge-completion-'));
  const state = await mkdtemp(join(realpathSync(tmpdir()), 'forge-completion-state-'));
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.name', 'Forge Test');
  git(repository, 'config', 'user.email', 'forge-test@example.com');
  await writeFile(join(repository, 'value.txt'), 'base\n');
  await writeFile(join(repository, 'other.txt'), 'untouched\n');
  await writeFile(
    join(repository, 'check.cjs'),
    `const fs = require('node:fs'); if(fs.readFileSync('value.txt','utf8') !== 'good\\n') { console.error('value must be good'); process.exit(1); }
${finalCheckFails ? "if(require('node:child_process').execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim() === 'main') { console.error('Final repository check failed'); process.exit(1); }" : ''}`
  );
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { check: 'node check.cjs' } })
  );
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'base');
  const graph: RepositoryGraph = {
    repositoryPath: repository,
    projects: new Map([
      [
        'fixture',
        {
          id: 'fixture',
          name: 'fixture',
          root: '.',
          packageJsonPath: 'package.json',
          dependencies: [],
          scripts: { check: 'node check.cjs' },
          sourceRoots: ['.'],
          tsconfigPaths: []
        }
      ]
    ]),
    files: new Map([
      [
        'fixture:value.txt',
        { id: 'fixture:value.txt', projectId: 'fixture', path: 'value.txt', isGenerated: false }
      ]
    ]),
    symbols: new Map(),
    projectDependencies: [],
    fileDependencies: [],
    symbolReferences: [],
    diagnostics: []
  };
  const impact = {
    taskId: 'change',
    projectsRead: new Set<string>(),
    projectsWritten: new Set<string>(),
    explicitProjectsWritten: new Set<string>(),
    filesRead: new Set<string>(),
    filesWritten: new Set(['fixture:value.txt']),
    explicitFilesWritten: new Set(['fixture:value.txt']),
    globFilesWritten: new Set<string>(),
    symbolDerivedFilesWritten: new Set<string>(),
    symbolsRead: new Set<string>(),
    symbolsWritten: new Set<string>(),
    sharedResources: new Set<string>(),
    sharedResourceAccesses: [],
    downstreamProjects: new Set<string>(),
    riskSignals: []
  };
  const prepared: PreparedOrchestrationPlan = {
    semanticReview: { recommendation: 'accept', summary: 'Covers the task.', requirements: [] },
    attempts: 1,
    specification: {
      tasks: [
        {
          id: 'change',
          title: 'Change',
          goal: 'Write good to value.txt',
          dependencies: [],
          expectedReads: [],
          expectedWrites: [{ type: 'file', value: 'value.txt' }],
          sharedResources: [],
          verification: [{ type: 'package-script', packageName: 'fixture', script: 'check' }]
        }
      ]
    },
    impacts: [impact],
    hardConflicts: [],
    riskConflicts: [],
    schedule: { maxConcurrency: 1 },
    executionPlan: { waves: [{ index: 0, taskIds: ['change'] }] }
  };
  const store = new LocalPlanStore(state);
  const plan = await store.save(repository, prepared);
  await store.approve(plan.id);
  const base = git(repository, 'rev-parse', 'HEAD');
  return {
    repository,
    state,
    store,
    plan,
    graph,
    base,
    close: async () => {
      await rm(repository, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  };
}
const reviewer: OutputReviewer = {
  review: async ({ diff, verification }) => {
    expect(diff.paths).toEqual(['value.txt']);
    expect(diff.patch).toContain('+');
    return verification.status === 'passed'
      ? { recommendation: 'accept', summary: 'Matches the task.', findings: [] }
      : {
          recommendation: 'reject',
          summary: 'The repository check failed.',
          findings: [{ path: 'value.txt', detail: verification.detail }]
        };
  }
};

describe('trustworthy local task completion', () => {
  it('analyzes the repository when no graph is supplied and uses the default output reviewer', async () => {
    const f = await fixture();
    const analyze = vi.spyOn(repositoryAnalysis, 'analyzeRepository').mockResolvedValue({
      graph: f.graph,
      providerId: 'fixture'
    });
    const review = vi.spyOn(PiOutputReviewer.prototype, 'review').mockResolvedValue({
      recommendation: 'accept',
      summary: 'Verified change',
      findings: []
    });
    try {
      const result = await runLocalPlan(f.store, f.plan.id, {
        verificationMode: 'repository',
        completion: {},
        agentRunner: {
          run: async (request) => {
            await request.onStarted({});
            await writeFile(join(request.workspace.workspacePath, 'value.txt'), 'good\n');
            return { status: 'completed' };
          }
        }
      });
      expect(analyze).toHaveBeenCalledWith(f.repository);
      expect(review).toHaveBeenCalledOnce();
      expect(result.taskStates[0]?.state).toBe('COMPLETED');
      expect(JSON.parse(await readFile(join(result.directory, 'run.json'), 'utf8'))).toMatchObject({
        verification: 'repository',
        review: 'live-pi'
      });
    } finally {
      analyze.mockRestore();
      review.mockRestore();
      await f.close();
    }
  });

  it('routes the explicit live CLI mode through Pi tools, real checks and one output review', async () => {
    const f = await fixture();
    let sessions = 0;
    let output = '';
    try {
      const program = createForgeProgram({
        writeOutput: (value) => {
          output += value;
        },
        localExecution: {
          liveGateway: {
            start: async (request) => {
              sessions += 1;
              await request.onStarted('test-pi-session');
              expect(request.tools).not.toContain('forge_command');
              expect(
                await request.executeTool({ name: 'forge_read', path: 'value.txt' })
              ).toMatchObject({ content: 'base\n' });
              expect(
                await request.executeTool({
                  name: 'forge_write',
                  path: 'value.txt',
                  content: 'good\n'
                })
              ).toMatchObject({ content: 'Wrote value.txt' });
              return { sessionId: 'test-pi-session' };
            }
          },
          completion: { graph: f.graph, reviewer }
        }
      });
      await program.parseAsync([
        'node',
        'forge',
        'run',
        f.plan.id,
        '--live',
        '--state-directory',
        f.state
      ]);
      expect(JSON.parse(output)).toMatchObject({
        execution: 'live',
        verification: 'repository',
        taskStates: [{ taskId: 'change', state: 'COMPLETED' }],
        finalRepository: {
          status: 'passed',
          clean: true,
          head: git(f.repository, 'rev-parse', 'HEAD')
        }
      });
      expect(sessions).toBe(1);
      expect(await readFile(join(f.repository, 'value.txt'), 'utf8')).toBe('good\n');
      expect(git(f.repository, 'status', '--porcelain')).toBe('');
    } finally {
      await f.close();
    }
  });

  it('reports a failed final repository check without rewriting integrated task facts', async () => {
    const f = await fixture(true);
    try {
      const result = await runLocalPlan(f.store, f.plan.id, {
        executionMode: 'live',
        liveGateway: {
          start: async (request) => {
            await request.onStarted('final-check-session');
            await request.executeTool({
              name: 'forge_write',
              path: 'value.txt',
              content: 'good\n'
            });
            return { sessionId: 'final-check-session' };
          }
        },
        verificationMode: 'repository',
        completion: { graph: f.graph, reviewer }
      });
      expect(result.taskStates[0]?.state).toBe('COMPLETED');
      expect(result.finalRepository).toMatchObject({ status: 'failed', clean: true });
      if (result.finalRepository?.status !== 'failed') {
        throw new Error('Expected the actual final repository check to fail.');
      }
      expect(result.finalRepository.detail).toContain('Final repository check failed');
      expect(git(f.repository, 'rev-parse', 'HEAD')).not.toBe(f.base);
      expect(
        JSON.parse(await readFile(join(result.directory, 'run.json'), 'utf8')).finalRepository
      ).toEqual(result.finalRepository);
    } finally {
      await f.close();
    }
  });

  it('reports a dirty final integration repository even when its command succeeds', async () => {
    const f = await fixture();
    try {
      await writeFile(
        join(f.repository, 'check.cjs'),
        (await readFile(join(f.repository, 'check.cjs'), 'utf8')) +
          "\nif(require('node:child_process').execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim() === 'main') fs.writeFileSync('final-generated.txt','generated');"
      );
      git(f.repository, 'add', 'check.cjs');
      git(f.repository, 'commit', '-m', 'Final command generates an untracked file');
      const plan = await f.store.save(f.repository, {
        attempts: 1,
        semanticReview: { recommendation: 'accept', summary: 'Same saved task.', requirements: [] },
        specification: { tasks: f.plan.tasks },
        impacts: f.plan.impacts,
        hardConflicts: [],
        riskConflicts: [],
        schedule: f.plan.schedule,
        executionPlan: { waves: [{ index: 0, taskIds: ['change'] }] }
      });
      await f.store.approve(plan.id);
      const result = await runLocalPlan(f.store, plan.id, {
        executionMode: 'live',
        liveGateway: {
          start: async (request) => {
            await request.onStarted('dirty-final-session');
            await request.executeTool({
              name: 'forge_write',
              path: 'value.txt',
              content: 'good\n'
            });
            return { sessionId: 'dirty-final-session' };
          }
        },
        verificationMode: 'repository',
        completion: { graph: f.graph, reviewer }
      });
      expect(result.finalRepository).toMatchObject({
        status: 'failed',
        clean: false,
        detail: 'Final integration repository has uncommitted changes.'
      });
      expect(result.taskStates[0]?.state).toBe('COMPLETED');
    } finally {
      await f.close();
    }
  });

  it('stops an unchanged writer without fabricating successful completion checks', async () => {
    const f = await fixture();
    try {
      const result = await runLocalPlan(f.store, f.plan.id, {
        verificationMode: 'repository',
        completion: {
          graph: f.graph,
          reviewer: {
            review: async () => {
              throw new Error('Review should not run for empty output.');
            }
          }
        }
      });
      expect(result.taskStates[0]?.state).toBe('FAILED');
      expect(git(f.repository, 'rev-parse', 'HEAD')).toBe(f.base);
      expect(
        await readFile(join(result.directory, 'completion', 'workspace-1.jsonl'), 'utf8')
      ).toContain('Writer produced no changes');
    } finally {
      await f.close();
    }
  });
  it('uses the CLI repository-checks path and integrates one accepted output', async () => {
    const f = await fixture();
    let writes = 0;
    let reviews = 0;
    let output = '';
    try {
      const program = createForgeProgram({
        writeOutput: (value) => {
          output += value;
        },
        localExecution: {
          agentRunner: {
            run: async (request) => {
              writes += 1;
              await request.onStarted({});
              await writeFile(join(request.workspace.workspacePath, 'value.txt'), 'good\n');
              return { status: 'completed' };
            }
          },
          completion: {
            graph: f.graph,
            reviewer: {
              review: async (request) => {
                reviews += 1;
                expect(request.verification.status).toBe('passed');
                return { recommendation: 'accept', summary: 'Reviewed output.', findings: [] };
              }
            }
          }
        }
      });
      await program.parseAsync([
        'node',
        'forge',
        'run',
        f.plan.id,
        '--controlled',
        '--repository-checks',
        '--state-directory',
        f.state
      ]);
      expect(JSON.parse(output)).toMatchObject({
        verification: 'repository',
        completion: 'reviewed',
        taskStates: [{ taskId: 'change', state: 'COMPLETED' }]
      });
      expect(writes).toBe(1);
      expect(reviews).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('preserves the failed output and evidence without calling the writer again', async () => {
    const f = await fixture();
    let calls = 0;
    try {
      const result = await runLocalPlan(f.store, f.plan.id, {
        verificationMode: 'repository',
        completion: { graph: f.graph, reviewer },
        agentRunner: {
          run: async (request) => {
            calls += 1;
            await request.onStarted({});
            await writeFile(join(request.workspace.workspacePath, 'value.txt'), 'bad\n');
            return { status: 'completed' };
          }
        }
      });
      expect(result.taskStates[0]?.state).toBe('FAILED');
      expect(calls).toBe(1);
      expect(git(f.repository, 'rev-parse', 'HEAD')).toBe(f.base);
      const consumed = await f.store.load(f.plan.id);
      expect(consumed.runId).toBeDefined();
      expect(
        await readFile(join(f.state, 'runs', consumed.runId!, 'task-1', 'value.txt'), 'utf8')
      ).toBe('bad\n');
      const evidence = await readFile(
        join(result.directory, 'completion', 'workspace-1.jsonl'),
        'utf8'
      );
      expect(evidence).toContain('value must be good');
    } finally {
      await f.close();
    }
  });
  it('records a real passed package check and accepted review before integrating one writer output', async () => {
    const f = await fixture();
    let calls = 0;
    try {
      const result = await runLocalPlan(f.store, f.plan.id, {
        agentRunner: {
          run: async (request) => {
            calls += 1;
            await request.onStarted({});
            await writeFile(join(request.workspace.workspacePath, 'value.txt'), 'good\n');
            return { status: 'completed' };
          }
        },
        verificationMode: 'repository',
        completion: { graph: f.graph, reviewer }
      });
      expect(result).toMatchObject({
        verification: 'repository',
        completion: 'reviewed',
        taskStates: [{ taskId: 'change', state: 'COMPLETED' }]
      });
      expect(calls).toBe(1);
      expect(await readFile(join(f.repository, 'value.txt'), 'utf8')).toBe('good\n');
      expect(git(f.repository, 'status', '--porcelain')).toBe('');
      const evidence = (
        await readFile(join(result.directory, 'completion', 'workspace-1.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        evidence
          .filter((row) => row.verification && !row.stage)
          .map((row) => row.verification.status)
      ).toEqual(['passed']);
      expect(evidence.filter((row) => row.review).map((row) => row.review.recommendation)).toEqual([
        'accept'
      ]);
      expect(
        JSON.parse(await readFile(join(result.directory, 'run.json'), 'utf8')).verification
      ).toBe('repository');
    } finally {
      await f.close();
    }
  });

  it.each([
    'scope',
    'reject',
    'verification',
    'mutating-review',
    'invalid-review',
    'agent-commit'
  ] as const)('does not integrate %s output', async (kind) => {
    const f = await fixture();
    let calls = 0;
    let reviews = 0;
    try {
      const result = await runLocalPlan(f.store, f.plan.id, {
        verificationMode: 'repository',
        agentRunner: {
          run: async (request) => {
            calls += 1;
            await request.onStarted({});
            await writeFile(
              join(request.workspace.workspacePath, kind === 'scope' ? 'other.txt' : 'value.txt'),
              kind === 'verification' ? 'bad\n' : 'good\n'
            );
            if (kind === 'agent-commit') {
              git(request.workspace.workspacePath, 'add', '.');
              git(request.workspace.workspacePath, 'commit', '-m', 'agent commit');
            }
            return { status: 'completed' };
          }
        },
        completion: {
          graph: f.graph,
          reviewer: {
            review: async (request) => {
              reviews += 1;
              if (kind === 'mutating-review') {
                await writeFile(join(request.workspace.workspacePath, 'value.txt'), 'unchecked\n');
              }
              if (kind === 'invalid-review') {
                return {
                  recommendation: 'reject',
                  summary: 'Invalid path.',
                  findings: [{ path: 'not-in-diff.txt', detail: 'wrong' }]
                };
              }
              if (kind === 'reject') {
                return {
                  recommendation: 'reject',
                  summary: 'Wrong behavior.',
                  findings: [{ path: 'value.txt', detail: 'Wrong behavior.' }]
                };
              }
              return reviewer.review(request);
            }
          }
        }
      });
      expect(result.taskStates).toEqual([{ taskId: 'change', state: 'FAILED' }]);
      expect(git(f.repository, 'rev-parse', 'HEAD')).toBe(f.base);
      expect(await readFile(join(f.repository, 'value.txt'), 'utf8')).toBe('base\n');
      expect(calls).toBe(1);
      if (kind === 'scope' || kind === 'agent-commit') {
        expect(reviews).toBe(0);
      }
    } finally {
      await f.close();
    }
  });

  it('does not accept a failed check even if the reviewer accepts, and labels injected verifiers explicitly', async () => {
    const f = await fixture();
    try {
      await expect(
        runLocalPlan(f.store, f.plan.id, {
          verifier: { verify: async () => ({ status: 'passed' }) }
        })
      ).rejects.toThrow('verificationMode');
      expect((await f.store.load(f.plan.id)).runId).toBeUndefined();
      const result = await runLocalPlan(f.store, f.plan.id, {
        verificationMode: 'custom',
        verifier: { verify: async () => ({ status: 'failed', detail: 'Rejected check' }) },
        agentRunner: {
          run: async (request) => {
            await request.onStarted({});
            await writeFile(join(request.workspace.workspacePath, 'value.txt'), 'good\n');
            return { status: 'completed' };
          }
        },
        completion: {
          graph: f.graph,
          reviewer: {
            review: async () => ({ recommendation: 'accept', summary: 'Accept', findings: [] })
          }
        }
      });
      expect(result.verification).toBe('custom');
      expect(result.taskStates[0]?.state).toBe('FAILED');
      expect(git(f.repository, 'rev-parse', 'HEAD')).toBe(f.base);
    } finally {
      await f.close();
    }
  });

  it('validates verifier mode before consuming an approved plan', async () => {
    const f = await fixture();
    try {
      await expect(runLocalPlan(f.store, f.plan.id, { executionMode: 'live' })).rejects.toThrow(
        'requires repository verification'
      );
      await expect(
        runLocalPlan(f.store, f.plan.id, {
          executionMode: 'live',
          verificationMode: 'repository',
          completion: { graph: f.graph },
          agentRunner: { run: async () => ({ status: 'completed' }) }
        })
      ).rejects.toThrow('not an injected controlled agent');
      await expect(
        runLocalPlan(f.store, f.plan.id, { verificationMode: 'custom' })
      ).rejects.toThrow('injected verifier');
      await expect(
        runLocalPlan(f.store, f.plan.id, { verificationMode: 'repository' })
      ).rejects.toThrow('completion pipeline');
      expect((await f.store.load(f.plan.id)).runId).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it.each(['outside-project', 'unplanned-file'] as const)(
    'stops live output for %s without integrating or calling a second writer',
    async (kind) => {
      const f = await fixture();
      let sessions = 0;
      try {
        const graph = {
          ...f.graph,
          projects: new Map(
            [...f.graph.projects].map(([id, project]) => [
              id,
              { ...project, root: kind === 'outside-project' ? 'src' : '.' }
            ])
          )
        };
        const result = await runLocalPlan(f.store, f.plan.id, {
          executionMode: 'live',
          verificationMode: 'repository',
          completion: {
            graph,
            reviewer: {
              review: async () => ({ recommendation: 'accept', summary: 'Accept', findings: [] })
            }
          },
          liveGateway: {
            start: async (options) => {
              sessions += 1;
              await options.onStarted('scope-test');
              await options.executeTool({
                name: 'forge_write',
                path: 'new.txt',
                content: 'unplanned'
              });
              return { sessionId: 'scope-test' };
            }
          }
        });
        expect(sessions).toBe(1);
        expect(result.taskStates[0]?.state).not.toBe('COMPLETED');
        expect(git(f.repository, 'rev-parse', 'HEAD')).toBe(f.base);
        await expect(readFile(join(result.directory, 'task-1', 'new.txt'))).rejects.toMatchObject({
          code: 'ENOENT'
        });
      } finally {
        await f.close();
      }
    }
  );

  it.each(['binary', 'symlink', 'large', 'outside'] as const)(
    'inspects newly created files and rejects %s output without integration',
    async (kind) => {
      const f = await fixture();
      let reviewed = false;
      try {
        const result = await runLocalPlan(f.store, f.plan.id, {
          verificationMode: 'repository',
          completion: {
            graph: f.graph,
            reviewer: {
              review: async () => {
                reviewed = true;
                return { recommendation: 'accept', summary: 'Accept', findings: [] };
              }
            }
          },
          agentRunner: {
            run: async (request) => {
              await request.onStarted({});
              const path = join(request.workspace.workspacePath, 'new.txt');
              if (kind === 'symlink') {
                await symlink(join(f.repository, 'value.txt'), path);
              } else {
                await writeFile(
                  path,
                  kind === 'binary'
                    ? '\0binary'
                    : kind === 'large'
                      ? 'x'.repeat(1024 * 1024 + 1)
                      : 'unplanned'
                );
              }
              return { status: 'completed' };
            }
          }
        });
        expect(result.taskStates[0]?.state).toBe('FAILED');
        expect(reviewed).toBe(false);
        expect(git(f.repository, 'rev-parse', 'HEAD')).toBe(f.base);
      } finally {
        await f.close();
      }
    }
  );

  it('runs approved command rules, reports missing/unknown scripts and refuses cwd outside the worktree', async () => {
    const f = await fixture();
    try {
      const verifier = new RepositoryTaskVerifier(f.graph, 1000);
      const request = {
        runId: 'test',
        task: f.plan.tasks[0],
        workspace: {
          id: 'w',
          runId: 'test',
          taskId: 'change',
          integrationRepositoryPath: f.repository,
          workspacePath: f.repository,
          branchName: 'main',
          baseRef: f.base,
          integrationRef: 'main',
          revision: 1,
          phase: 'READY_TO_INTEGRATE' as const
        }
      };
      expect(
        await verifier.verify({ ...request, task: { ...request.task, verification: [] } })
      ).toMatchObject({ status: 'failed' });
      expect(
        await verifier.verify({
          ...request,
          task: {
            ...request.task,
            verification: [{ type: 'package-script', packageName: 'unknown', script: 'check' }]
          }
        })
      ).toMatchObject({ status: 'failed', detail: expect.stringContaining('Unknown') });
      expect(
        await verifier.verify({
          ...request,
          task: {
            ...request.task,
            verification: [{ type: 'command', command: 'exit 0', cwd: '..' }]
          }
        })
      ).toMatchObject({ status: 'failed', detail: expect.stringContaining('inside') });
      expect(
        await verifier.verify({
          ...request,
          task: { ...request.task, verification: [{ type: 'command', command: 'exit 0' }] }
        })
      ).toEqual({ status: 'passed' });
      expect(
        await verifier.verify({
          ...request,
          task: {
            ...request.task,
            verification: [{ type: 'command', command: 'echo check-failed >&2; exit 3', cwd: '.' }]
          }
        })
      ).toMatchObject({ status: 'failed', detail: expect.stringContaining('check-failed') });
      expect(
        await verifier.verify({
          ...request,
          task: {
            ...request.task,
            verification: [{ type: 'package-script', packageName: 'fixture', script: 'missing' }]
          }
        })
      ).toMatchObject({ status: 'failed' });
      const review = new PiOutputReviewer({
        generate: async (generation) => {
          expect(await generation.executeTool({ name: 'forge_projects' })).toMatchObject({
            isError: true
          });
          expect(generation.prompt).toContain('actual diff');
          expect(generation.prompt).toContain('findings MUST be an empty array');
          expect(generation.prompt).toContain('not praise');
          expect(generation.prompt).toContain('at least one actionable unresolved defect');
          expect(generation.prompt.endsWith('Never omit findings, including for accept.')).toBe(
            true
          );
          return {
            sessionId: 'controlled',
            output: '{"recommendation":"accept","summary":"Reviewed","findings":[]}'
          };
        }
      });
      expect(
        await review.review({
          ...request,
          diff: { paths: [], patch: '' },
          verification: { status: 'passed' },
          round: 0
        })
      ).toMatchObject({ recommendation: 'accept' });
    } finally {
      await f.close();
    }
  });
});
