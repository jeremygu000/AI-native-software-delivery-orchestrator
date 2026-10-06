import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PreparedOrchestrationPlan } from '@ai-native-software-delivery-orchestrator/planning';
import { describe, expect, it } from 'vitest';

import { createForgeProgram } from './app.js';
import { LocalPlanStore } from './local-plan.js';
import { runLocalPlan } from './local-run.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function fixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'forge-local-plan-'));
  git(directory, 'init', '--initial-branch=main');
  git(directory, 'config', 'user.name', 'Forge Test');
  git(directory, 'config', 'user.email', 'forge-test@example.com');
  await writeFile(join(directory, 'value.txt'), 'base\n');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'base');
  const state = await mkdtemp(join(realpathSync(tmpdir()), 'forge-local-state-'));
  const prepared: PreparedOrchestrationPlan = {
    attempts: 1,
    specification: {
      tasks: [
        {
          id: 'edit-value',
          title: 'Edit value',
          goal: 'Change value.txt',
          dependencies: [],
          expectedReads: [],
          expectedWrites: [{ type: 'file', value: 'value.txt' }],
          sharedResources: [],
          verification: [{ type: 'package-script', packageName: 'fixture', script: 'check' }]
        }
      ]
    },
    impacts: [
      {
        taskId: 'edit-value',
        projectsRead: new Set(),
        projectsWritten: new Set(),
        explicitProjectsWritten: new Set(),
        filesRead: new Set(),
        filesWritten: new Set(['fixture:value.txt']),
        explicitFilesWritten: new Set(['fixture:value.txt']),
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
    executionPlan: { waves: [{ index: 0, taskIds: ['edit-value'] }] },
    schedule: { maxConcurrency: 1 },
    semanticReview: {
      recommendation: 'accept',
      summary: 'Covers the request.',
      requirements: [
        {
          requirement: 'Change value',
          status: 'covered',
          taskIds: ['edit-value'],
          detail: 'The task edits value.'
        }
      ]
    }
  };
  return {
    directory,
    state,
    prepared,
    store: new LocalPlanStore(state),
    close: async () => {
      await rm(directory, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  };
}

describe('simple local plan product path', () => {
  it('labels default no-op controlled execution honestly and preserves a failed verifier result without integration', async () => {
    const f = await fixture();
    try {
      const original = git(f.directory, 'rev-parse', 'HEAD');
      const plan = await f.store.save(f.directory, f.prepared);
      await f.store.approve(plan.id);
      const result = await runLocalPlan(f.store, plan.id);
      expect(result).toMatchObject({
        execution: 'controlled',
        verification: 'fake',
        taskStates: [{ taskId: 'edit-value', state: 'COMPLETED' }]
      });
      expect(git(f.directory, 'rev-parse', 'HEAD')).toBe(original);
      const second = await f.store.save(f.directory, f.prepared);
      await f.store.approve(second.id);
      const failed = await runLocalPlan(f.store, second.id, {
        verificationMode: 'custom',
        verifier: { verify: async () => ({ status: 'failed', detail: 'Controlled rejection' }) }
      });
      expect(failed.taskStates).toEqual([{ taskId: 'edit-value', state: 'FAILED' }]);
      expect(git(f.directory, 'rev-parse', 'HEAD')).toBe(original);
    } finally {
      await f.close();
    }
  });
  it('plans, saves, inspects, explicitly approves and runs through real Git/SQLite using a controlled writer', async () => {
    const f = await fixture();
    try {
      let output = '';
      let agents = 0;
      const command = async (...args: string[]) => {
        output = '';
        const program = createForgeProgram({
          cwd: f.directory,
          planRepository: async () => f.prepared,
          writeOutput: (value) => {
            output += value;
          },
          localExecution: {
            agentRunner: {
              run: async (request) => {
                agents += 1;
                await request.onStarted({
                  sessionRef: { backend: 'controlled', value: 'test-session' }
                });
                await writeFile(
                  join(request.workspace.workspacePath, 'value.txt'),
                  'controlled change\n'
                );
                return { status: 'completed' };
              }
            }
          }
        });
        program.exitOverride();
        for (const subcommand of program.commands) {
          subcommand.exitOverride();
          subcommand.configureOutput({ writeErr: () => {} });
        }
        program.configureOutput({ writeErr: () => {} });
        await program.parseAsync(['node', 'forge', ...args, '--state-directory', f.state]);
        return output;
      };
      const saved = JSON.parse(await command('plan', 'request.md', '--semantic-review', '--save'));
      const id: string = saved.planId;
      expect(saved).toMatchObject({
        approved: false,
        repositoryCommit: git(f.directory, 'rev-parse', 'HEAD')
      });
      expect(JSON.parse(await command('show', id))).toMatchObject({
        id,
        approved: false,
        tasks: [{ id: 'edit-value' }]
      });
      await expect(command('run', id, '--controlled')).rejects.toThrow('not approved');
      await expect(command('approve', id)).rejects.toMatchObject({
        code: 'commander.missingMandatoryOptionValue'
      });
      expect(agents).toBe(0);
      await command('approve', id, '--yes');
      await expect(command('run', id)).rejects.toThrow('Select exactly one execution mode');
      await expect(command('run', id, '--controlled', '--live')).rejects.toThrow(
        'Select exactly one execution mode'
      );
      const result = JSON.parse(await command('run', id, '--controlled'));
      expect(result).toMatchObject({
        planId: id,
        execution: 'controlled',
        verification: 'fake',
        taskStates: [{ taskId: 'edit-value', state: 'COMPLETED' }]
      });
      expect(await readFile(join(f.directory, 'value.txt'), 'utf8')).toBe('controlled change\n');
      expect(git(f.directory, 'status', '--porcelain')).toBe('');
      expect(git(f.directory, 'log', '-1', '--format=%s')).toBe('forge: edit-value');
      expect(agents).toBe(1);
      await expect(command('run', id, '--controlled')).rejects.toThrow('already been run');
      await expect(command('approve', id, '--yes')).rejects.toThrow('already been run');
    } finally {
      await f.close();
    }
  });

  it('stops an approved plan when the repository is dirty or its commit changed, before creating a run', async () => {
    const f = await fixture();
    try {
      const saved = await f.store.save(f.directory, f.prepared);
      await f.store.approve(saved.id);
      await writeFile(join(f.directory, 'value.txt'), 'changed elsewhere\n');
      await expect(f.store.beginRun(saved.id)).rejects.toThrow('uncommitted changes');
      expect((await f.store.load(saved.id)).runId).toBeUndefined();
      git(f.directory, 'add', '.');
      git(f.directory, 'commit', '-m', 'other work');
      await expect(f.store.beginRun(saved.id)).rejects.toThrow('Repository changed');
      expect((await f.store.load(saved.id)).runId).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('validates local files and keeps Forge state outside the repository', async () => {
    const f = await fixture();
    try {
      await expect(f.store.load('../escape')).rejects.toThrow();
      await expect(f.store.load('00000000-0000-4000-8000-000000000001')).rejects.toThrow();
      await expect(
        new LocalPlanStore(join(f.directory, 'state')).save(f.directory, f.prepared)
      ).rejects.toThrow('outside');
      const plan = await f.store.save(f.directory, f.prepared);
      const path = join(f.state, 'plans', `${plan.id}.json`);
      await writeFile(
        path,
        JSON.stringify(
          { ...plan, id: '00000000-0000-4000-8000-000000000001', impacts: plan.impacts },
          (_key, value: unknown) => (value instanceof Set ? { $set: [...value] } : value)
        )
      );
      await expect(f.store.load(plan.id)).rejects.toThrow('filename');
      await writeFile(path, '{}');
      await expect(f.store.load(plan.id)).rejects.toThrow();
      await expect(f.store.save(f.directory, { ...f.prepared, impacts: [] })).rejects.toThrow(
        'impacts'
      );
    } finally {
      await f.close();
    }
  });

  it('does not save a plan against a commit changed during planning, or accept a dirty/non-root repository', async () => {
    const f = await fixture();
    try {
      const initial = git(f.directory, 'rev-parse', 'HEAD');
      await writeFile(join(f.directory, 'value.txt'), 'external change\n');
      await expect(f.store.save(f.directory, f.prepared)).rejects.toThrow('uncommitted changes');
      git(f.directory, 'add', '.');
      git(f.directory, 'commit', '-m', 'external change');
      await expect(f.store.save(f.directory, f.prepared, initial)).rejects.toThrow(
        'during planning'
      );
      await expect(f.store.save(join(f.directory, '.git'), f.prepared)).rejects.toThrow();
      await expect(
        f.store.save(f.directory, {
          ...f.prepared,
          specification: {
            tasks: [...f.prepared.specification.tasks, ...f.prepared.specification.tasks]
          },
          impacts: [...f.prepared.impacts, ...f.prepared.impacts]
        })
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
});
