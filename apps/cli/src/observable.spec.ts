import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PreparedOrchestrationPlan } from '@ai-native-software-delivery-orchestrator/planning';
import { LocalPlanStore } from './local-plan.js';
import { runLocalPlan } from './local-run.js';
import { listLocalPlans, readRunView } from './run-view.js';
import { startObservableServer } from './observable-server.js';
import { ObservableTuiController, renderObservableTui, TuiScreen } from './observable-tui.js';
import { CompletionStage } from './completion-values.js';
import Database from 'better-sqlite3';
import { runViewSchema, planListingSchema } from './run-view-schema.js';
import { createForgeProgram } from './app.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function fixture() {
  const repository = await mkdtemp(join(realpathSync(tmpdir()), 'observable-repo-'));
  const state = await mkdtemp(join(realpathSync(tmpdir()), 'observable-state-'));
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.name', 'Forge Test');
  git(repository, 'config', 'user.email', 'test@example.com');
  await writeFile(join(repository, 'value.txt'), 'base\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'base');
  const prepared: PreparedOrchestrationPlan = {
    attempts: 1,
    specification: {
      tasks: [
        {
          id: 'edit',
          title: 'Edit value',
          goal: 'Change value',
          description: 'Only value.txt',
          dependencies: [],
          expectedReads: [],
          expectedWrites: [{ type: 'file', value: 'value.txt' }],
          sharedResources: [],
          verification: []
        }
      ]
    },
    impacts: [
      {
        taskId: 'edit',
        projectsRead: new Set(),
        projectsWritten: new Set(),
        explicitProjectsWritten: new Set(),
        filesRead: new Set(),
        filesWritten: new Set(['repo:value.txt']),
        explicitFilesWritten: new Set(['repo:value.txt']),
        globFilesWritten: new Set(),
        symbolDerivedFilesWritten: new Set(),
        symbolsRead: new Set(),
        symbolsWritten: new Set(),
        sharedResources: new Set(),
        sharedResourceAccesses: [],
        downstreamProjects: new Set(),
        riskSignals: []
      }
    ],
    hardConflicts: [],
    riskConflicts: [],
    executionPlan: { waves: [{ index: 0, taskIds: ['edit'] }] },
    schedule: { maxConcurrency: 1 },
    semanticReview: { recommendation: 'accept', summary: 'Matches request', requirements: [] }
  };
  return {
    repository,
    state,
    prepared,
    store: new LocalPlanStore(state),
    close: async () => {
      await rm(repository, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  };
}

describe('Observable Forge local product', () => {
  it('shows recorded pending dependency tasks while two writers are running', async () => {
    const f = await fixture();
    try {
      const first = f.prepared.specification.tasks[0];
      const impact = f.prepared.impacts[0];
      const prepared: PreparedOrchestrationPlan = {
        ...f.prepared,
        specification: {
          tasks: [
            first,
            { ...first, id: 'second' },
            { ...first, id: 'dependent', dependencies: ['edit', 'second'] }
          ]
        },
        impacts: [
          impact,
          { ...impact, taskId: 'second', filesWritten: new Set(['repo:other.txt']) },
          { ...impact, taskId: 'dependent' }
        ],
        schedule: { maxConcurrency: 2 }
      };
      const plan = await f.store.save(f.repository, prepared);
      await f.store.approve(plan.id);
      const writersStarted = Promise.withResolvers<void>();
      const releaseWriters = Promise.withResolvers<void>();
      let count = 0;
      const running = runLocalPlan(f.store, plan.id, {
        agentRunner: {
          run: async (request) => {
            await request.onStarted({});
            if (++count === 2) {
              writersStarted.resolve();
            }
            if (request.taskId !== 'dependent') {
              await releaseWriters.promise;
            }
            return { status: 'completed' };
          }
        }
      });
      await writersStarted.promise;
      try {
        const view = await readRunView(f.store, plan.id);
        expect(view.tasks.map((task) => task.state)).toEqual(['RUNNING', 'RUNNING', 'PENDING']);
      } finally {
        releaseWriters.resolve();
        await running;
      }
    } finally {
      await f.close();
    }
  });

  it('reads real SQLite terminal facts and completion evidence without changing the database, plan or Git', async () => {
    const f = await fixture();
    try {
      expect(await listLocalPlans(f.store)).toEqual([]);
      const plan = await f.store.save(f.repository, f.prepared);
      expect(await readRunView(f.store, plan.id)).toMatchObject({
        state: 'PLANNED',
        approved: false,
        tasks: [{ state: 'NOT_RECORDED' }]
      });
      await f.store.approve(plan.id);
      expect((await readRunView(f.store, plan.id)).state).toBe('APPROVED');
      const result = await runLocalPlan(f.store, plan.id, {
        agentRunner: {
          run: async (input) => {
            await input.onStarted({});
            await writeFile(join(input.workspace.workspacePath, 'value.txt'), 'changed\n');
            return { status: 'completed' };
          }
        }
      });
      const directory = result.directory;
      await mkdir(join(directory, 'completion'), { recursive: true });
      await writeFile(
        join(directory, 'completion/workspace-1.jsonl'),
        `${JSON.stringify({ stage: CompletionStage.Reviewing, diff: { paths: ['value.txt'], patch: '+changed' }, verification: { status: 'passed' }, review: { recommendation: 'accept', summary: 'Approved', findings: [] } })}\n`
      );
      const database = await readFile(join(directory, 'state.sqlite'));
      const savedPlan = await readFile(join(f.state, 'plans', `${plan.id}.json`));
      const head = git(f.repository, 'rev-parse', 'HEAD');
      const view = await readRunView(f.store, plan.id);
      expect(view).toMatchObject({
        state: 'COMPLETED',
        execution: 'controlled',
        verificationMode: 'fake',
        tasks: [
          {
            state: 'COMPLETED',
            actualFiles: ['value.txt'],
            diff: '+changed',
            integratedCommit: head,
            verification: { status: 'passed' },
            review: { recommendation: 'accept' }
          }
        ]
      });
      expect(await readFile(join(directory, 'state.sqlite'))).toEqual(database);
      expect(await readFile(join(f.state, 'plans', `${plan.id}.json`))).toEqual(savedPlan);
      expect(git(f.repository, 'status', '--porcelain')).toBe('');
      await appendFile(join(directory, 'completion/workspace-1.jsonl'), '{partial');
      expect((await readRunView(f.store, plan.id)).warnings).toContain(
        'Incomplete or invalid completion evidence for edit.'
      );
      await writeFile(join(f.state, 'plans', '00000000-0000-0000-0000-000000000000.json'), '{}');
      expect(await listLocalPlans(f.store)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('does not invent success for failed verification, missing databases, or absent evidence', async () => {
    const f = await fixture();
    try {
      const plan = await f.store.save(f.repository, f.prepared);
      await f.store.approve(plan.id);
      const result = await runLocalPlan(f.store, plan.id, {
        verificationMode: 'custom',
        verifier: { verify: async () => ({ status: 'failed', detail: 'Rejected check' }) }
      });
      const failed = await readRunView(f.store, plan.id);
      expect(failed).toMatchObject({
        state: 'FAILED',
        tasks: [{ state: 'FAILED', actualFiles: [] }]
      });
      expect(failed.tasks[0]?.integratedCommit).toBeUndefined();
      expect(failed.tasks[0]?.verification).toBeUndefined();
      await rm(join(result.directory, 'state.sqlite'));
      const missing = await readRunView(f.store, plan.id);
      expect(missing.state).toBe('NOT_RECORDED');
      expect(missing.warnings).toHaveLength(1);
      expect(await readFile(join(f.state, 'plans', `${plan.id}.json`), 'utf8')).toContain(
        result.runId
      );
    } finally {
      await f.close();
    }
  });

  it('serves only loopback GET read models and fixed assets, with no browser mutation controls', async () => {
    const f = await fixture();
    const assets = await mkdtemp(join(realpathSync(tmpdir()), 'observable-assets-'));
    await writeFile(join(assets, 'index.html'), '<h1>Forge read-only</h1>');
    await writeFile(join(assets, 'app.js'), 'export {};');
    await writeFile(join(assets, 'app.css'), 'body{}');
    const server = await startObservableServer(f.store, 0, assets);
    try {
      const plan = await f.store.save(f.repository, f.prepared);
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(await (await fetch(`${server.url}/api/plans`)).json()).toEqual([
        { id: plan.id, approved: false }
      ]);
      expect(await (await fetch(`${server.url}/api/plans/${plan.id}`)).json()).toMatchObject({
        approved: false,
        state: 'PLANNED'
      });
      for (const path of ['/', '/app.js', '/app.css']) {
        expect((await fetch(`${server.url}${path}`)).status).toBe(200);
      }
      expect((await fetch(`${server.url}/api/plans/${plan.id}`, { method: 'POST' })).status).toBe(
        405
      );
      expect((await fetch(`${server.url}/approve`)).status).toBe(404);
      expect(
        (await fetch(`${server.url}/api/plans/00000000-0000-0000-0000-000000000000`)).status
      ).toBe(404);
      expect((await f.store.load(plan.id)).approved).toBe(false);
      await rm(join(assets, 'app.css'));
      expect((await fetch(`${server.url}/app.css`)).status).toBe(404);
      const output: string[] = [];
      const program = createForgeProgram({ writeOutput: (text) => output.push(text) });
      await program.parseAsync(['node', 'forge', 'view', plan.id, '--state-directory', f.state]);
      expect(JSON.parse(output[0])).toMatchObject({ planId: plan.id, approved: false });
    } finally {
      await server.close();
      await f.close();
      await rm(assets, { recursive: true, force: true });
    }
  });

  it('adapts multiline planning, explicit approval and controlled execution to the existing operations', async () => {
    const f = await fixture();
    try {
      let planned = 0;
      let written = 0;
      const tui = new ObservableTuiController({
        directory: f.state,
        repository: f.repository,
        dependencies: {
          planRepository: async (request) => {
            planned++;
            expect(request.maxConcurrency).toBe(2);
            expect(await readFile(request.specificationPath, 'utf8')).toBe(
              'First line\nSecond line'
            );
            return f.prepared;
          },
          localExecution: {
            agentRunner: {
              run: async (input) => {
                written++;
                await input.onStarted({});
                await writeFile(join(input.workspace.workspacePath, 'value.txt'), 'tui change\n');
                return { status: 'completed' };
              }
            }
          }
        }
      });
      await tui.refresh();
      await tui.key('p');
      await tui.key('p');
      await tui.key('p');
      expect(tui.state.maxConcurrency).toBe(4);
      await tui.key('p');
      expect(tui.state.maxConcurrency).toBe(1);
      await tui.key('p');
      await tui.key('n');
      await tui.key('', 'First line');
      await tui.key('return');
      await tui.key('', 'Second line');
      expect(planned).toBe(0);
      await tui.key('return', '', true);
      expect(planned).toBe(1);
      expect(tui.state.screen).toBe(TuiScreen.Plan);
      expect(tui.state.view?.approved).toBe(false);
      await tui.key('c');
      expect(written).toBe(0);
      await tui.key('a');
      expect(tui.state.view?.approved).toBe(true);
      await tui.key('c');
      expect(written).toBe(1);
      expect(tui.state.view?.state).toBe('COMPLETED');
      expect(renderObservableTui(tui.state)).toContain('controlled');
      expect(renderObservableTui(tui.state)).toContain('fake');
      await tui.key('pagedown');
      await tui.key('pageup');
      expect(tui.state.scroll).toBe(0);
      await tui.key('escape');
      await tui.key('return');
      await tui.key('a');
      expect(tui.state.screen).toBe(TuiScreen.Plan);
      await tui.key('n');
      await tui.key('s', '', true);
      expect(tui.state.error).toContain('Enter a request');
      await tui.key('escape');
      tui.state.view = undefined;
      expect(renderObservableTui(tui.state)).toContain('Saved plans');
    } finally {
      await f.close();
    }
  });

  it('copies complete plain-text diagnostics without viewport truncation, including while working', async () => {
    const f = await fixture();
    try {
      let copied = '';
      const tui = new ObservableTuiController({
        directory: f.state,
        repository: f.repository,
        copy: async (text) => {
          copied = text;
          return 'Copied diagnostics';
        }
      });
      tui.state.screen = TuiScreen.Running;
      tui.state.busy = true;
      tui.state.error = `First error\n${'long diagnostic '.repeat(100)}\nLast error`;
      tui.state.scroll = 100;
      await tui.key('y', '', true);
      expect(copied).toContain('First error');
      expect(copied).toContain('Last error');
      expect(copied).not.toContain('\x1b');
      expect(copied.length).toBeGreaterThan(renderObservableTui(tui.state, 25, 8).length);
      expect(tui.state.message).toBe('Copied diagnostics');
      tui.state.screen = TuiScreen.Request;
      tui.state.busy = false;
      await tui.key('y', 'y');
      expect(tui.state.input).toBe('y');
    } finally {
      await f.close();
    }
  });

  it('shows active, incomplete and malformed local observations without changing them', async () => {
    const f = await fixture();
    try {
      const plan = await f.store.save(f.repository, f.prepared);
      await f.store.approve(plan.id);
      const result = await runLocalPlan(f.store, plan.id);
      const path = join(result.directory, 'state.sqlite');
      const db = new Database(path);
      db.prepare('DELETE FROM scheduler_events WHERE run_id = ?').run(result.runId);
      db.prepare('DELETE FROM task_transitions WHERE run_id = ?').run(result.runId);
      db.prepare('DELETE FROM task_workspaces WHERE run_id = ?').run(result.runId);
      db.close();
      const active = runViewSchema.parse(await readRunView(f.store, plan.id));
      const metadata = JSON.parse(await readFile(join(result.directory, 'run.json'), 'utf8'));
      await writeFile(
        join(result.directory, 'run.json'),
        JSON.stringify({
          ...metadata,
          finalRepository: {
            status: 'failed',
            detail: 'Combined checks failed',
            head: git(f.repository, 'rev-parse', 'HEAD'),
            clean: false
          }
        })
      );
      const finalFailure = await readRunView(f.store, plan.id);
      expect(finalFailure.finalRepository).toMatchObject({ status: 'failed', clean: false });
      const presentation = new ObservableTuiController({
        directory: f.state,
        repository: f.repository
      });
      presentation.state.view = finalFailure;
      presentation.state.screen = TuiScreen.Result;
      expect(renderObservableTui(presentation.state, 160, 50)).toContain(
        'Final repository checks: failed'
      );
      expect(active.state).toBe('ACTIVE');
      expect(active.recordedRunState).toBe('ACTIVE');
      expect(active.tasks[0]?.state).toBe('PENDING');
      expect(planListingSchema.parse(await listLocalPlans(f.store))).toHaveLength(1);
      const observations = new Database(path);
      observations.prepare('DELETE FROM scheduler_decisions WHERE run_id = ?').run(result.runId);
      expect((await readRunView(f.store, plan.id)).tasks[0]?.state).toBe('NOT_RECORDED');
      observations
        .prepare(
          "INSERT INTO scheduler_events (run_id, sequence, occurred_at, event_json) VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?)"
        )
        .run(
          result.runId,
          100,
          JSON.stringify({ type: 'task-failed', taskId: 'edit', state: 'FAILED' })
        );
      expect((await readRunView(f.store, plan.id)).state).toBe('FAILED');
      observations
        .prepare(
          'INSERT INTO task_transitions (run_id, sequence, ordinal, task_id, from_state, to_state) VALUES (?, ?, 0, ?, ?, ?)'
        )
        .run(result.runId, 101, 'edit', 'FAILED', 'CANCELLED');
      expect((await readRunView(f.store, plan.id)).state).toBe('CANCELLED');
      observations.close();
      const corrupt = new Database(path);
      corrupt
        .prepare("UPDATE agent_execution_attempts SET attempt_json = '{}' WHERE run_id = ?")
        .run(result.runId);
      corrupt.close();
      expect((await readRunView(f.store, plan.id)).warnings).toContain(
        'Recorded run data could not be decoded. Missing facts are not reported as success.'
      );
      await rm(join(result.directory, 'run.json'));
      expect((await readRunView(f.store, plan.id)).execution).toBeUndefined();
      await rm(join(f.state, 'plans'), { recursive: true });
      expect(await listLocalPlans(f.store)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('keeps presentation actions explicit, bounded and usable after command or copy failures', async () => {
    const f = await fixture();
    try {
      const plan = await f.store.save(f.repository, f.prepared);
      const tui = new ObservableTuiController({
        directory: f.state,
        repository: f.repository,
        copy: async () => {
          throw new Error('Unavailable');
        },
        dependencies: {
          planRepository: async () => {
            throw new Error('Private model error');
          }
        }
      });
      await tui.refresh();
      await tui.key('down');
      await tui.key('up');
      await tui.key('return');
      expect(tui.state.planId).toBe(plan.id);
      await tui.key('y');
      expect(tui.state.message).toContain('Could not copy');
      tui.state.planId = '00000000-0000-0000-0000-000000000000';
      await tui.refresh();
      expect(tui.state.error).toBe('Local plan/run evidence is unavailable.');
      tui.state.planId = plan.id;
      await tui.refresh();
      tui.state.busy = true;
      await tui.key('a');
      expect((await f.store.load(plan.id)).approved).toBe(false);
      await tui.key('pagedown');
      expect(tui.state.scroll).toBe(8);
      tui.state.busy = false;
      await tui.key('n');
      await tui.key('', 'ab');
      await tui.key('backspace');
      await tui.key('return');
      expect(tui.state.input).toBe('a\n');
      tui.state.busy = true;
      await tui.key('', 'ignored');
      expect(tui.state.input).toBe('a\n');
      tui.state.busy = false;
      await tui.key('s', '', true);
      expect(tui.state.error).not.toContain('Private model');
      expect(tui.state.error).toContain('Operation failed');
      await tui.key('escape');
      await tui.key('return');
      await tui.key('a');
      tui.state.view = {
        ...runViewSchema.parse(await readRunView(f.store, plan.id)),
        tasks: [
          {
            id: 'task',
            title: 'Task',
            goal: 'Goal',
            state: 'FAILED',
            plannedFiles: [],
            actualFiles: [],
            failure: 'Full failure',
            worktree: '/worktree',
            integratedCommit: 'commit',
            diff: '+change',
            verification: { status: 'failed', detail: 'Check output' },
            review: {
              recommendation: 'reject',
              summary: 'Review summary',
              findings: [{ path: 'value.txt', detail: 'Finding' }]
            }
          }
        ],
        edges: [
          { id: 'edge', source: 'task', target: 'other', kind: 'conflict', label: 'hard conflict' }
        ],
        warnings: ['Observation warning']
      };
      const rendered = renderObservableTui(tui.state, 200, 100);
      for (const text of [
        'Full failure',
        'Check output',
        'Review summary',
        'Finding',
        '/worktree',
        'commit',
        '+change',
        'hard conflict',
        'Observation warning'
      ]) {
        expect(rendered).toContain(text);
      }
      tui.state.screen = TuiScreen.Request;
      expect(renderObservableTui(tui.state)).toContain('Request');
      tui.state.view = undefined;
      tui.state.screen = TuiScreen.Result;
      expect(renderObservableTui(tui.state)).toContain('Screen: result');
    } finally {
      await f.close();
    }
  });
});
