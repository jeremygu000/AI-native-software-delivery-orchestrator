import { describe, expect, it } from 'vitest';

import {
  createTaskWorkspaceRequestSchema,
  disposeTaskWorkspaceRequestSchema,
  taskWorkspaceSchema
} from './workspace.js';

const workspace = {
  id: 'workspace-1',
  runId: 'run-1',
  taskId: 'task-1',
  integrationRepositoryPath: '/repository',
  workspacePath: '/workspaces/task-1',
  branchName: 'orchestrator/run-1/task-1',
  baseRef: 'main',
  integrationRef: 'main',
  revision: 1,
  phase: 'READY_TO_INTEGRATE'
} as const;

describe('workspace contracts', () => {
  it('parses a workspace that is ready to integrate', () => {
    expect(taskWorkspaceSchema.parse(workspace)).toEqual(workspace);
    expect(createTaskWorkspaceRequestSchema.parse(workspace)).toEqual({
      id: workspace.id,
      runId: workspace.runId,
      taskId: workspace.taskId,
      integrationRepositoryPath: workspace.integrationRepositoryPath,
      workspacePath: workspace.workspacePath,
      branchName: workspace.branchName,
      baseRef: workspace.baseRef,
      integrationRef: workspace.integrationRef
    });
  });

  it('retains structured phase-aware integration blocking evidence', () => {
    expect(
      taskWorkspaceSchema.parse({
        ...workspace,
        phase: 'INTEGRATION_BLOCKED',
        blocker: { type: 'rebase-conflict', detail: 'Conflict.', conflictPaths: ['src/value.ts'] }
      })
    ).toMatchObject({ phase: 'INTEGRATION_BLOCKED' });
    expect(
      taskWorkspaceSchema.safeParse({ ...workspace, phase: 'INTEGRATION_BLOCKED' }).success
    ).toBe(false);
    expect(taskWorkspaceSchema.safeParse({ ...workspace, phase: 'INTEGRATED' }).success).toBe(
      false
    );
  });

  it('requires a positive workspace revision', () => {
    expect(taskWorkspaceSchema.safeParse({ ...workspace, revision: 0 }).success).toBe(false);
  });

  it('requires an explicit integration checkout path', () => {
    const { integrationRepositoryPath: _integrationRepositoryPath, ...legacyWorkspace } = workspace;
    expect(
      taskWorkspaceSchema.safeParse({ ...legacyWorkspace, repositoryPath: '/repository' }).success
    ).toBe(false);
  });

  it('defaults disposal to protecting dirty workspaces', () => {
    expect(disposeTaskWorkspaceRequestSchema.parse({ workspace })).toEqual({
      workspace,
      force: false
    });
  });

  it('requires an explicit reason for force disposal', () => {
    expect(disposeTaskWorkspaceRequestSchema.safeParse({ workspace, force: true }).success).toBe(
      false
    );
    expect(
      disposeTaskWorkspaceRequestSchema.safeParse({
        workspace,
        force: true,
        reason: 'Discard unrecoverable task output.'
      }).success
    ).toBe(true);
  });
});
