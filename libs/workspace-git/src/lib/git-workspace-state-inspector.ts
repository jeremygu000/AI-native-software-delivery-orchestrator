import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  taskWorkspaceSchema,
  type TaskWorkspace
} from '@ai-native-software-delivery-orchestrator/domain';

export interface GitWorkspaceInspection {
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly worktreePath: string;
  readonly integrationRepositoryPath: string;
  readonly commonGitDirectory: string;
  readonly headCommit: string;
  readonly baseCommit: string;
  readonly branchRef: string;
  readonly branchCommit: string;
  readonly clean: true;
}

export interface GitWorkspaceInspectionRequest {
  /** The persisted workspace record is an identity to verify, not evidence of Git state. */
  readonly workspace: TaskWorkspace;
  /** The repository root and base commit pinned by the approved plan before Git creation. */
  readonly approvedRepositoryRoot: string;
  readonly approvedBaseCommit: string;
}

export class GitWorkspaceInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitWorkspaceInspectionError';
  }
}

const git = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((complete, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }, (error, stdout) => {
      if (error !== null) {
        reject(new GitWorkspaceInspectionError(`Could not inspect Git ${args[0] ?? 'state'}`));
        return;
      }
      complete(stdout);
    });
  });

const canonical = (path: string): Promise<string> => realpath(resolve(path));
const commitOid = /^[0-9a-f]{40,64}$/;
const sameOrWithin = (parent: string, child: string): boolean => {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === '' ||
    (pathFromParent !== '..' &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
};

/** Read-only recovery observation. A separate supervisor must prove non-resumability and sign it. */
export class GitWorkspaceStateInspector {
  async inspect(request: GitWorkspaceInspectionRequest): Promise<GitWorkspaceInspection> {
    const workspace = taskWorkspaceSchema.parse(request.workspace);
    if (workspace.phase !== 'READY_TO_INTEGRATE' || workspace.revision !== 1) {
      throw new GitWorkspaceInspectionError(
        'Workspace is not at the initial Git creation revision'
      );
    }
    if (!commitOid.test(request.approvedBaseCommit)) {
      throw new GitWorkspaceInspectionError('Approved base commit is not a pinned Git object ID');
    }

    const [worktreePath, integrationRepositoryPath, approvedRepositoryRoot] = await Promise.all([
      canonical(workspace.workspacePath),
      canonical(workspace.integrationRepositoryPath),
      canonical(request.approvedRepositoryRoot)
    ]);
    if (
      integrationRepositoryPath !== approvedRepositoryRoot ||
      sameOrWithin(integrationRepositoryPath, worktreePath) ||
      sameOrWithin(worktreePath, integrationRepositoryPath)
    ) {
      throw new GitWorkspaceInspectionError(
        'Workspace and approved integration repository must be separate'
      );
    }

    const [worktreeRoot, integrationRoot, worktreeCommon, integrationCommon] = await Promise.all([
      git(worktreePath, ['rev-parse', '--show-toplevel']),
      git(integrationRepositoryPath, ['rev-parse', '--show-toplevel']),
      git(worktreePath, ['rev-parse', '--git-common-dir']),
      git(integrationRepositoryPath, ['rev-parse', '--git-common-dir'])
    ]);
    const [actualWorktreeRoot, actualIntegrationRoot, commonGitDirectory, integrationGitDirectory] =
      await Promise.all([
        canonical(worktreeRoot.trim()),
        canonical(integrationRoot.trim()),
        canonical(resolve(worktreePath, worktreeCommon.trim())),
        canonical(resolve(integrationRepositoryPath, integrationCommon.trim()))
      ]);
    if (
      actualWorktreeRoot !== worktreePath ||
      actualIntegrationRoot !== integrationRepositoryPath ||
      commonGitDirectory !== integrationGitDirectory
    ) {
      throw new GitWorkspaceInspectionError(
        'Git worktree does not belong to the approved repository'
      );
    }

    const expectedBranch = `refs/heads/${workspace.branchName}`;
    const [branchRef, headCommit, branchCommit, status] = await Promise.all([
      git(worktreePath, ['symbolic-ref', '--quiet', 'HEAD']),
      git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']),
      git(worktreePath, ['rev-parse', '--verify', `${expectedBranch}^{commit}`]),
      git(worktreePath, [
        '-c',
        'core.fsmonitor=false',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching'
      ])
    ]);
    if (
      branchRef.trim() !== expectedBranch ||
      headCommit.trim() !== request.approvedBaseCommit ||
      branchCommit.trim() !== request.approvedBaseCommit ||
      status.length !== 0
    ) {
      throw new GitWorkspaceInspectionError('Git branch, base commit or initial worktree differs');
    }
    return {
      workspaceId: workspace.id,
      workspaceRevision: workspace.revision,
      worktreePath,
      integrationRepositoryPath,
      commonGitDirectory,
      headCommit: headCommit.trim(),
      baseCommit: request.approvedBaseCommit,
      branchRef: expectedBranch,
      branchCommit: branchCommit.trim(),
      clean: true
    };
  }
}
