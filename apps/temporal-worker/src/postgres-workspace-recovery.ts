import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  PostgresGlobalMutationAuthority,
  PostgresExecutionGenerationIssuer,
  PostgresOrchestrationPersistence,
  type PostgresEvidenceStoreConfiguration,
  type WorkspaceSetupRecoverySnapshot
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import {
  DockerWorkspaceGenerationSupervisor,
  type GitWorkspaceInspection,
  type SupervisedWorkspaceGeneration
} from '@ai-native-software-delivery-orchestrator/workspace-git';
import type { TaskWorkspace } from '@ai-native-software-delivery-orchestrator/domain';

/** Observations made by a separate recovery process, not a handoff attestation. */
export interface WorkspaceRecoveryObservation {
  readonly authority: WorkspaceSetupRecoverySnapshot;
  readonly git: GitWorkspaceInspection;
  readonly containerExitCode: number;
}

/**
 * This composition must run outside the writer container, with the restricted
 * generation-issuer login and Docker daemon credentials unavailable to the
 * normal worker. It cannot settle an orphan Git permit or mint a child claim.
 */
export class PostgresWorkspaceRecoveryObserver {
  constructor(
    private readonly dependencies: {
      readonly authority: Pick<PostgresGlobalMutationAuthority, 'recoverWorkspaceSetupEvidence'>;
      readonly issuer: Pick<PostgresExecutionGenerationIssuer, 'revoke'>;
      readonly persistence: {
        recoverRun(runId: string): Promise<
          | {
              readonly run: {
                readonly state: string;
                readonly authority: {
                  readonly repositoryRoot: string;
                  readonly baseCommit: string;
                };
              };
              readonly workspaces: readonly { readonly workspace: TaskWorkspace }[];
              readonly taskBindings: readonly {
                readonly taskId: string;
                readonly agentId: string;
                readonly workspace: { readonly id: string; readonly workspacePath: string };
              }[];
            }
          | undefined
        >;
      };
      readonly supervisor: Pick<
        DockerWorkspaceGenerationSupervisor,
        'stopAndVerify' | 'assertStopped' | 'inspectStoppedWorkspace'
      >;
    }
  ) {}

  async observe(generation: SupervisedWorkspaceGeneration): Promise<WorkspaceRecoveryObservation> {
    return this.#observe(generation, false);
  }

  /** Inspect a lost Git completion response without clearing its one-shot lineage. */
  async observePendingPermit(
    generation: SupervisedWorkspaceGeneration
  ): Promise<WorkspaceRecoveryObservation> {
    return this.#observe(generation, true);
  }

  /** Recheck stopped containment and real Git after a committed handoff, without reopening its parent. */
  async verifyCommittedGit(
    generation: SupervisedWorkspaceGeneration,
    signed: WorkspaceRecoveryObservation
  ): Promise<void> {
    const { authority, git } = signed;
    if (
      authority.scopeId !== generation.scopeId ||
      authority.parentClaimId !== generation.parentClaimId ||
      authority.workspaceId !== generation.workspaceId ||
      authority.generation?.id !== generation.generationId ||
      authority.generation.supervisorId !== generation.supervisorId ||
      authority.generation.state !== 'REVOKED' ||
      authority.workspace?.revision !== 1 ||
      (await realpath(resolve(authority.workspace.workspacePath))) !== generation.workspacePath
    ) {
      throw new Error('Committed recovery does not match the supervised generation');
    }
    const run = await this.dependencies.persistence.recoverRun(authority.owner.runId);
    const workspace = run?.workspaces.find(
      (row) => row.workspace.id === generation.workspaceId
    )?.workspace;
    const binding = run?.taskBindings.find((row) => row.taskId === authority.owner.taskId);
    if (
      run?.run.state !== 'ACTIVE' ||
      workspace === undefined ||
      workspace.revision !== 1 ||
      workspace.workspacePath !== authority.workspace.workspacePath ||
      workspace.branchName !== authority.workspace.branchName ||
      workspace.integrationRepositoryPath !== run.run.authority.repositoryRoot ||
      binding?.agentId !== authority.owner.agentId ||
      binding.workspace.id !== workspace.id ||
      binding.workspace.workspacePath !== workspace.workspacePath
    ) {
      throw new Error('Committed recovery workspace no longer matches its approved run');
    }
    await this.dependencies.supervisor.assertStopped(generation);
    const currentGit = await this.dependencies.supervisor.inspectStoppedWorkspace(generation, {
      workspace,
      approvedRepositoryRoot: run.run.authority.repositoryRoot,
      approvedBaseCommit: run.run.authority.baseCommit
    });
    await this.dependencies.supervisor.assertStopped(generation);
    const checked = await this.dependencies.persistence.recoverRun(authority.owner.runId);
    const checkedWorkspace = checked?.workspaces.find(
      (row) => row.workspace.id === generation.workspaceId
    )?.workspace;
    if (
      JSON.stringify(currentGit) !== JSON.stringify(git) ||
      checked?.run.state !== 'ACTIVE' ||
      checked.run.authority.repositoryRoot !== run.run.authority.repositoryRoot ||
      checked.run.authority.baseCommit !== run.run.authority.baseCommit ||
      checkedWorkspace?.revision !== workspace.revision ||
      checkedWorkspace.workspacePath !== workspace.workspacePath ||
      checkedWorkspace.branchName !== workspace.branchName
    ) {
      throw new Error('Committed recovery Git identity changed');
    }
  }

  async #observe(
    generation: SupervisedWorkspaceGeneration,
    pendingPermit: boolean
  ): Promise<WorkspaceRecoveryObservation> {
    const initial = await this.dependencies.authority.recoverWorkspaceSetupEvidence(
      generation.scopeId,
      generation.parentClaimId
    );
    if (
      initial.workspaceId !== generation.workspaceId ||
      initial.generation?.id !== generation.generationId ||
      initial.generation.supervisorId !== generation.supervisorId ||
      (initial.generation.state !== 'ISSUED' && initial.generation.state !== 'REVOKED') ||
      (initial.phase !== 'WORKSPACE_ARMED' && initial.phase !== 'WORKSPACE_UNCERTAIN') ||
      initial.permit === undefined
    ) {
      throw new Error('Recovery generation does not match durable parent authority');
    }
    // The durable revocation is irreversible and precedes any external stop or
    // Git inspection. If the stop fails, the parent remains blocking.
    await this.dependencies.issuer.revoke(generation.generationId, generation.scopeId);
    // If the issuer response was lost after commit, a second call replays the
    // irreversible revocation before the container is inspected or stopped.
    const stopped = await this.dependencies.supervisor.stopAndVerify(generation);
    const current = await this.dependencies.authority.recoverWorkspaceSetupEvidence(
      generation.scopeId,
      generation.parentClaimId
    );
    const approvedWorkspacePath =
      current.workspace === undefined
        ? undefined
        : await realpath(resolve(current.workspace.workspacePath));
    if (
      current.generation?.id !== generation.generationId ||
      current.generation.state !== 'REVOKED' ||
      current.generation.supervisorId !== generation.supervisorId ||
      current.workspaceId !== generation.workspaceId ||
      current.parentState !== (pendingPermit ? 'ACTIVE' : 'HELD_UNCERTAIN') ||
      current.phase !== (pendingPermit ? 'WORKSPACE_ARMED' : 'WORKSPACE_UNCERTAIN') ||
      current.permit?.completed !== !pendingPermit ||
      current.workspace?.revision !== 1 ||
      approvedWorkspacePath !== generation.workspacePath ||
      current.runState !== 'ACTIVE' ||
      current.owner.taskId !== initial.owner.taskId ||
      current.owner.agentId !== initial.owner.agentId ||
      current.owner.workspaceId !== initial.owner.workspaceId ||
      current.permit.id !== initial.permit?.id ||
      current.signingKey !== initial.signingKey ||
      current.authorizationDigest !== initial.authorizationDigest ||
      current.parentClaimId !== initial.parentClaimId ||
      current.token !== initial.token ||
      current.version !==
        initial.version + (!initial.permit?.completed && !pendingPermit ? 1 : 0) ||
      current.owner.runId !== initial.owner.runId ||
      current.owner.attemptId !== initial.owner.attemptId ||
      current.setupPlanDigest !== initial.setupPlanDigest ||
      current.executionPlanDigest !== initial.executionPlanDigest
    ) {
      throw new Error('Recovery authority is not an uncertain completed workspace setup');
    }
    const run = await this.dependencies.persistence.recoverRun(current.owner.runId);
    const workspace = run?.workspaces.find(
      (row) => row.workspace.id === generation.workspaceId
    )?.workspace;
    const binding = run?.taskBindings.find((row) => row.taskId === current.owner.taskId);
    if (
      run?.run.state !== 'ACTIVE' ||
      workspace === undefined ||
      binding === undefined ||
      workspace.runId !== current.owner.runId ||
      workspace.taskId !== current.owner.taskId ||
      workspace.workspacePath !== current.workspace.workspacePath ||
      workspace.integrationRepositoryPath !== run.run.authority.repositoryRoot ||
      binding.workspace.id !== workspace.id ||
      binding.workspace.workspacePath !== workspace.workspacePath ||
      binding.agentId !== current.owner.agentId
    ) {
      throw new Error('Recovery workspace does not match the bound approved run');
    }
    await this.dependencies.supervisor.assertStopped(generation);
    const git = await this.dependencies.supervisor.inspectStoppedWorkspace(generation, {
      workspace,
      approvedRepositoryRoot: run.run.authority.repositoryRoot,
      approvedBaseCommit: run.run.authority.baseCommit
    });
    await this.dependencies.supervisor.assertStopped(generation);
    const checkedRun = await this.dependencies.persistence.recoverRun(current.owner.runId);
    const checkedWorkspace = checkedRun?.workspaces.find(
      (row) => row.workspace.id === generation.workspaceId
    )?.workspace;
    const checkedBinding = checkedRun?.taskBindings.find(
      (row) => row.taskId === current.owner.taskId
    );
    if (
      checkedRun?.run.state !== 'ACTIVE' ||
      checkedRun.run.authority.repositoryRoot !== run.run.authority.repositoryRoot ||
      checkedRun.run.authority.baseCommit !== run.run.authority.baseCommit ||
      checkedWorkspace?.revision !== workspace.revision ||
      checkedWorkspace.workspacePath !== workspace.workspacePath ||
      checkedWorkspace.branchName !== workspace.branchName ||
      checkedWorkspace.integrationRepositoryPath !== workspace.integrationRepositoryPath ||
      checkedBinding?.agentId !== binding.agentId ||
      checkedBinding.workspace.id !== binding.workspace.id ||
      checkedBinding.workspace.workspacePath !== binding.workspace.workspacePath
    ) {
      throw new Error('Recovery approved run or workspace changed during Git inspection');
    }
    const final = await this.dependencies.authority.recoverWorkspaceSetupEvidence(
      generation.scopeId,
      generation.parentClaimId
    );
    const finalWorkspacePath =
      final.workspace === undefined
        ? undefined
        : await realpath(resolve(final.workspace.workspacePath));
    if (
      final.generation?.state !== 'REVOKED' ||
      final.generation.id !== generation.generationId ||
      final.generation.supervisorId !== generation.supervisorId ||
      final.parentState !== (pendingPermit ? 'ACTIVE' : 'HELD_UNCERTAIN') ||
      final.phase !== (pendingPermit ? 'WORKSPACE_ARMED' : 'WORKSPACE_UNCERTAIN') ||
      final.runState !== 'ACTIVE' ||
      final.permit?.id !== current.permit.id ||
      final.permit.completed !== !pendingPermit ||
      final.workspace?.revision !== current.workspace.revision ||
      final.workspace.branchName !== current.workspace.branchName ||
      finalWorkspacePath !== git.worktreePath ||
      final.token !== current.token ||
      final.version !== current.version ||
      final.owner.runId !== current.owner.runId ||
      final.owner.taskId !== current.owner.taskId ||
      final.owner.attemptId !== current.owner.attemptId ||
      final.owner.agentId !== current.owner.agentId ||
      final.owner.workspaceId !== current.owner.workspaceId ||
      final.signingKey !== current.signingKey ||
      final.authorizationDigest !== current.authorizationDigest ||
      final.executionPlanDigest !== current.executionPlanDigest ||
      final.setupPlanDigest !== current.setupPlanDigest
    ) {
      throw new Error('Recovery authority changed during Git inspection');
    }
    return { authority: final, git, containerExitCode: stopped.exitCode };
  }
}

/** A separately deployed recovery service; never inject its issuer or Docker login into a writer. */
export async function openPostgresWorkspaceRecoveryObserver(configuration: {
  readonly runtime: PostgresEvidenceStoreConfiguration;
  readonly issuer: PostgresEvidenceStoreConfiguration;
  readonly supervisorId: string;
  readonly image: string;
}): Promise<{ readonly observer: PostgresWorkspaceRecoveryObserver; close(): Promise<void> }> {
  if (
    configuration.runtime.connectionString === configuration.issuer.connectionString ||
    configuration.runtime.role === configuration.issuer.role ||
    configuration.runtime.schema !== configuration.issuer.schema
  ) {
    throw new Error('Workspace recovery requires a separate generation issuer and matching scope');
  }
  const supervisor = new DockerWorkspaceGenerationSupervisor({
    supervisorId: configuration.supervisorId,
    image: configuration.image
  });
  const authority = await PostgresGlobalMutationAuthority.connect(configuration.runtime);
  let issuer: PostgresExecutionGenerationIssuer | undefined;
  let persistence: PostgresOrchestrationPersistence | undefined;
  try {
    issuer = await PostgresExecutionGenerationIssuer.connect(configuration.issuer);
    persistence = await PostgresOrchestrationPersistence.connect(configuration.runtime);
    const connectedIssuer = issuer;
    const connectedPersistence = persistence;
    return {
      observer: new PostgresWorkspaceRecoveryObserver({
        authority,
        issuer: connectedIssuer,
        persistence: connectedPersistence,
        supervisor
      }),
      close: async () => {
        await Promise.all([
          authority.close(),
          connectedIssuer.close(),
          connectedPersistence.close()
        ]);
      }
    };
  } catch (error) {
    await Promise.all([authority.close(), issuer?.close(), persistence?.close()]);
    throw error;
  }
}
