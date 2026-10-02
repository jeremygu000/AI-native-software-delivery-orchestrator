import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  type RepositorySnapshotProvider,
  type WorkspaceManager
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  PostgresGlobalMutationAuthority,
  type GlobalIntegrationExecution
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';

const inspectGit = (cwd: string, args: string[]): Promise<string> =>
  new Promise((complete, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }, (error, stdout) => {
      if (error !== null) {
        reject(error);
      } else {
        complete(stdout.trim());
      }
    });
  });
const within = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const assertGitIdentity = async (execution: GlobalIntegrationExecution): Promise<void> => {
  const worktree = await realpath(resolve(execution.workspace.workspacePath));
  const integration = await realpath(resolve(execution.workspace.integrationRepositoryPath));
  if (within(worktree, integration) || within(integration, worktree)) {
    throw new Error('Integration requires separate approved linked Git worktrees');
  }
  const [worktreeRoot, integrationRoot, worktreeCommon, integrationCommon, branch] =
    await Promise.all([
      inspectGit(worktree, ['rev-parse', '--show-toplevel']),
      inspectGit(integration, ['rev-parse', '--show-toplevel']),
      inspectGit(worktree, ['rev-parse', '--git-common-dir']),
      inspectGit(integration, ['rev-parse', '--git-common-dir']),
      inspectGit(worktree, ['symbolic-ref', '--quiet', 'HEAD'])
    ]);
  if (
    (await realpath(worktreeRoot)) !== worktree ||
    (await realpath(integrationRoot)) !== integration ||
    (await realpath(resolve(worktree, worktreeCommon))) !==
      (await realpath(resolve(integration, integrationCommon))) ||
    branch !== `refs/heads/${execution.workspace.branchName}`
  ) {
    throw new Error('Integration Git identity differs from the approved workspace');
  }
};

/** Executes one admitted commit/rebase/merge sequence. Blocked or uncertain Git
 * outcomes require independent recovery; this runner never resumes them. */
export class PostgresIntegrationRunner {
  constructor(
    private readonly options: {
      authority: PostgresGlobalMutationAuthority;
      snapshots: RepositorySnapshotProvider;
      workspaceManager: Pick<WorkspaceManager, 'commit' | 'integrate'>;
      confirmStopped?: (execution: GlobalIntegrationExecution) => Promise<string>;
    }
  ) {}

  async run(execution: GlobalIntegrationExecution): Promise<'RELEASED' | 'HELD_UNCERTAIN'> {
    if (execution.state === 'RUNNING') {
      await this.options.authority.finishIntegrationExecution(execution, {
        state: 'UNKNOWN',
        detail: 'Recovered Git launch requires independent process and repository recovery'
      });
      throw new Error(
        'Running integration requires independent recovery; Git will not be relaunched'
      );
    }
    const running = await this.options.authority.startIntegrationExecution(execution, randomUUID());
    const permit = await this.options.authority.beginFencedMutation({
      ...running,
      resource: { type: 'repository' }
    });
    let result: Awaited<ReturnType<WorkspaceManager['integrate']>>;
    try {
      await assertGitIdentity(running);
      const snapshot = await this.options.snapshots.capture({
        repositoryPath: running.workspace.workspacePath
      });
      if (snapshot.workingTreeFingerprint !== running.subject.workspaceChangeFingerprint) {
        throw new Error('Integration output changed after accepted review');
      }
      await this.options.workspaceManager.commit({
        workspace: running.workspace,
        message: `forge: ${running.owner.taskId}\n\nForge-Run-Id: ${running.owner.runId}`
      });
      result = await this.options.workspaceManager.integrate(running.workspace);
    } catch (error) {
      await this.options.authority.finishIntegrationExecution(running, {
        state: 'UNKNOWN',
        detail: `Integration Git failed: ${error instanceof Error ? error.message : 'non-error rejection'}`,
        permit
      });
      throw error;
    }
    let stopEvidence: string | undefined;
    if (result.status === 'integrated' && this.options.confirmStopped !== undefined) {
      try {
        stopEvidence = await this.options.confirmStopped(running);
      } catch {
        /* An unconfirmed process outcome must retain repository ownership. */
      }
    }
    const outcome = {
      state: result.status === 'integrated' ? ('INTEGRATED' as const) : ('BLOCKED' as const),
      detail: `Git integration returned ${result.status}`,
      workspace: result.workspace,
      permit
    };
    return this.options.authority
      .finishIntegrationExecution(running, {
        ...outcome,
        ...(stopEvidence === undefined ? {} : { stopEvidence })
      })
      .catch(async (error) => {
        if (stopEvidence === undefined) {
          throw error;
        }
        return this.options.authority.finishIntegrationExecution(running, outcome);
      });
  }
}
