import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  JsonFilePlanApprovalStore,
  JsonFilePlanArtifactStore,
  JsonFileWorkspaceSetupApprovalStore
} from '@ai-native-software-delivery-orchestrator/persistence';
import {
  createWorkspaceSetupApproval,
  fingerprintPlanValue,
  workspaceSetupAuthorizationMessage
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  PostgresExecutionGenerationIssuer,
  PostgresGlobalMutationAuthority,
  PostgresOrchestrationPersistence,
  PostgresWorkspaceSetupAdmission,
  resolvePostgresConnectionSsl
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import {
  DockerWorkspaceGenerationSupervisor,
  GitWorkspaceStateInspector,
  GitWorkspaceManager
} from '@ai-native-software-delivery-orchestrator/workspace-git';
import { openPostgresWorkspaceRecoveryObserver } from './postgres-workspace-recovery.js';
import { WorkspaceRecoveryAttestor } from './workspace-recovery-attestation.js';
import { PostgresWorkspaceHandoff } from './postgres-workspace-handoff.js';

export interface WorkspaceSetupRequest {
  readonly root: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactRevision?: number;
  readonly approvalId: string;
  readonly planDirectory?: string;
  readonly approvedBy?: string;
  readonly authorizeWorkspaceCreation: true;
  readonly operation?: string;
  readonly runtimeConnectionString?: string;
  readonly runtimeSchema?: string;
  readonly writeOutput?: (output: string) => void;
}

/** Explicit operator boundary; never creates a worker or forwards privileged credentials. */
export async function prepareApprovedWorkspaces(
  operatorRequest: WorkspaceSetupRequest
): Promise<void> {
  if (!operatorRequest.authorizeWorkspaceCreation) {
    throw new Error('Explicit workspace setup authorization is required');
  }
  // Operator composition keeps privileged credentials separate from the worker.
  const root = operatorRequest.root;
  const localEnv = parseEnv(await readFile(resolve(root, '.env.local'), 'utf8'));
  const comparisonEnv = process.env.FORGE_COMPARISON_ENV_FILE
    ? parseEnv(await readFile(process.env.FORGE_COMPARISON_ENV_FILE, 'utf8'))
    : {};
  const env = { ...localEnv, ...comparisonEnv };
  const ssl = resolvePostgresConnectionSsl(
    env.FORGE_POSTGRES_SSL ?? process.env.FORGE_POSTGRES_SSL
  );
  const { runId, artifactId, approvalId, operation } = operatorRequest;
  if (operation !== undefined && operation !== '--abandon') {
    throw new Error('Unknown operator operation');
  }
  if (!runId || !artifactId || !approvalId) {
    throw new Error('Usage: prepare-workspaces run-id artifact-id approval-id');
  }
  const config = (role: string, password: string | undefined) => {
    if (process.env.FORGE_COMPARISON_ENV_FILE) {
      const key = `FORGE_${role.slice('forge_'.length).toUpperCase()}_CONNECTION_STRING`;
      const connectionString = localEnv[key];
      if (!connectionString) {
        throw new Error(`Missing independent Neon operator connection for ${role}`);
      }
      const url = new URL(connectionString);
      const runtimeUrl = new URL(env.FORGE_POSTGRES_CONNECTION_STRING ?? '');
      if (
        url.username !== role ||
        url.host !== runtimeUrl.host ||
        url.pathname !== runtimeUrl.pathname
      ) {
        throw new Error(`Neon operator connection does not match comparison authority: ${role}`);
      }
      return { connectionString, schema: env.FORGE_POSTGRES_SCHEMA ?? 'forge', role, ssl };
    }
    if (!password) {
      throw new Error('Missing independent operator credential');
    }
    const url = new URL(env.FORGE_POSTGRES_CONNECTION_STRING ?? '');
    url.username = role;
    url.password = password;
    return {
      connectionString: url.toString(),
      schema: env.FORGE_POSTGRES_SCHEMA ?? 'forge',
      role,
      ssl
    };
  };
  const runtime = config('forge_runtime', env.LOCAL_FORGE_RUNTIME_PASSWORD);
  const issuerConfig = config('forge_issuer', env.LOCAL_FORGE_ISSUER_PASSWORD);
  const recoveryConfig = config('forge_recovery', env.LOCAL_FORGE_RECOVERY_PASSWORD);
  const setupConfig = config('forge_setup', env.LOCAL_FORGE_SETUP_PASSWORD);
  if (operatorRequest.runtimeConnectionString !== undefined) {
    const actual = new URL(runtime.connectionString);
    const expected = new URL(operatorRequest.runtimeConnectionString);
    if (
      actual.host !== expected.host ||
      actual.pathname !== expected.pathname ||
      actual.username !== expected.username ||
      runtime.schema !== operatorRequest.runtimeSchema
    ) {
      throw new Error('Operator configuration does not match the selected runtime authority');
    }
  }
  const plans = operatorRequest.planDirectory ?? resolve(root, '.local/plans');
  const artifact = await new JsonFilePlanArtifactStore(plans).load(
    artifactId,
    operatorRequest.artifactRevision ?? 1
  );
  const approval = await new JsonFilePlanApprovalStore(plans).load(approvalId);
  if (!artifact || !approval) {
    throw new Error('Missing exact approved plan');
  }
  const resources: (() => Promise<void>)[] = [];
  const retain = async <T extends { close(): Promise<void> }>(pending: Promise<T>): Promise<T> => {
    const resource = await pending;
    resources.push(() => resource.close());
    return resource;
  };
  try {
    const persistence = await retain(PostgresOrchestrationPersistence.connect(runtime));
    const authority = await retain(PostgresGlobalMutationAuthority.connect(runtime));
    const setup = await retain(PostgresWorkspaceSetupAdmission.connect(setupConfig));
    const issuer = await retain(PostgresExecutionGenerationIssuer.connect(issuerConfig));
    const privateKey = await readFile(resolve(root, '.local/setup-private.pem'), 'utf8');
    await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
    let recoveryPrivate: string;
    let recoveryPublic: string;
    try {
      recoveryPrivate = await readFile(resolve(root, '.local/recovery-private.pem'), 'utf8');
      recoveryPublic = await readFile(resolve(root, '.local/recovery-public.pem'), 'utf8');
    } catch {
      const pair = generateKeyPairSync('ed25519');
      recoveryPrivate = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
      recoveryPublic = pair.publicKey.export({ type: 'spki', format: 'pem' });
      await writeFile(resolve(root, '.local/recovery-private.pem'), recoveryPrivate, {
        flag: 'wx',
        mode: 0o600
      });
      await writeFile(resolve(root, '.local/recovery-public.pem'), recoveryPublic, {
        flag: 'wx',
        mode: 0o600
      });
    }
    const supervisorId = 'local-independent-setup-supervisor';
    const image = 'node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43';
    const observer = await retain(
      openPostgresWorkspaceRecoveryObserver({
        runtime,
        issuer: issuerConfig,
        supervisorId,
        image
      })
    );
    const handoff = await retain(
      PostgresWorkspaceHandoff.connect({
        recovery: recoveryConfig,
        runtime,
        issuer: issuerConfig,
        observer: observer.observer,
        keyId: 'local-recovery',
        publicKey: recoveryPublic
      })
    );
    const recovered = await persistence.recoverRun(runId);
    if (!recovered || recovered.run.authority?.approvalId !== approvalId) {
      throw new Error('Run does not match the approved execution');
    }
    const scopeId = await authority.recoverGlobalRunScope(runId);
    for (const { attempt } of recovered.attempts) {
      if (attempt.state === 'COMPLETED') {
        continue;
      }
      if (attempt.state !== 'PREPARING' && attempt.state !== 'STARTING') {
        throw new Error('Only initial setup attempts may be prepared');
      }
      const binding = recovered.taskBindings.find((item) => item.taskId === attempt.taskId);
      if (!binding) {
        throw new Error('Missing approved task binding');
      }
      const parentClaimId = `setup-${runId}-${attempt.taskId}`;
      const generationId = `setup-generation-${runId}-${attempt.taskId}`;
      const setupStore = new JsonFileWorkspaceSetupApprovalStore(plans);
      const setupApproval =
        (await setupStore.load(`git-${runId}-${attempt.taskId}`)) ??
        createWorkspaceSetupApproval({
          setupApprovalId: `git-${runId}-${attempt.taskId}`,
          artifact,
          executionApproval: approval,
          taskId: attempt.taskId,
          approvedBy: operatorRequest.approvedBy ?? 'local-user-authorized-git-setup',
          approvedAt: new Date().toISOString()
        });
      await setupStore.save(setupApproval);
      const authorization = {
        schemaVersion: 1 as const,
        keyId: 'local-setup',
        setupApprovalId: setupApproval.setupApprovalId,
        setupApprovalFingerprint: setupApproval.setupApprovalFingerprint,
        signature: sign(
          null,
          workspaceSetupAuthorizationMessage(setupApproval, 'local-setup'),
          privateKey
        ).toString('base64url')
      };
      const request = {
        scopeId,
        runId,
        attemptId: attempt.id,
        parentClaimId,
        workspaceId: binding.workspace.id,
        artifact,
        executionApproval: approval,
        setupApproval,
        authorization,
        binding
      };
      if (operation === '--abandon' && attempt.state !== 'STARTING') {
        throw new Error('Abandonment requires an existing uncertain setup, not new admission');
      }
      if (attempt.state === 'PREPARING') {
        const admitted = await setup.admit(request);
        if (admitted.status !== 'granted') {
          throw new Error('Setup blocked by existing owner; independent recovery required');
        }
        await issuer.issue({
          generationId,
          scopeId,
          parentClaimId,
          runId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          workspaceId: binding.workspace.id,
          supervisorId,
          setupPlanDigest: setupApproval.setupApprovalFingerprint.slice(7),
          executionPlanDigest: fingerprintPlanValue(binding.leasePlan).slice(7)
        });
        await setup.arm({ ...request, generationId });
        await setup.executeWorkspaceCreation(
          {
            ...request,
            generationId,
            supervisorId,
            token: admitted.token,
            version: 1
          },
          async () => {
            // Branch/worktree creation is inside the dedicated repository Git permit.
            try {
              execFileSync(
                'git',
                [
                  '-C',
                  binding.workspace.integrationRepositoryPath,
                  'rev-parse',
                  '--verify',
                  binding.workspace.integrationRef
                ],
                { stdio: 'ignore' }
              );
            } catch {
              execFileSync(
                'git',
                [
                  '-C',
                  binding.workspace.integrationRepositoryPath,
                  'branch',
                  binding.workspace.integrationRef,
                  binding.workspace.baseRef
                ],
                { stdio: 'ignore' }
              );
            }
            const workspace = await new GitWorkspaceManager().create(binding.workspace);
            await persistence.persistWorkspace({ runId, workspace });
          },
          () => 'Independent local setup process completed and awaited Git workspace creation'
        );
      } else {
        const evidence = await authority.recoverWorkspaceSetupEvidence(scopeId, parentClaimId);
        if (evidence.phase !== 'WORKSPACE_UNCERTAIN' || evidence.permit?.completed !== true) {
          throw new Error(
            'Interrupted setup requires independent permit recovery; never repeat Git'
          );
        }
        const workspace = {
          ...binding.workspace,
          revision: 1,
          phase: 'READY_TO_INTEGRATE' as const
        };
        await new GitWorkspaceStateInspector().inspect({
          workspace,
          approvedRepositoryRoot: artifact.repository.repositoryRoot,
          approvedBaseCommit: artifact.repository.baseCommit
        });
        await persistence.persistWorkspace({ runId, workspace });
      }
      const supervisor = new DockerWorkspaceGenerationSupervisor({
        supervisorId,
        image
      });
      const identity = {
        scopeId,
        parentClaimId,
        generationId,
        workspaceId: binding.workspace.id,
        workspacePath: binding.workspace.workspacePath
      };
      const containerName = `forge-generation-${createHash('sha256')
        .update(JSON.stringify([scopeId, generationId]))
        .digest('hex')}`;
      let existingContainer: string | undefined;
      try {
        existingContainer = execFileSync(
          'docker',
          ['inspect', containerName, '--format', '{{.Id}}'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
      } catch {
        /* No existing container: the supervisor performs a new launch. */
      }
      const canonical = await realpath(binding.workspace.workspacePath);
      const metadata = await stat(canonical, { bigint: true });
      const generation =
        existingContainer === undefined
          ? await supervisor.launch({
              ...identity,
              command: ['node', '-e', 'setInterval(()=>{},1000)']
            })
          : {
              ...identity,
              workspacePath: canonical,
              workspaceDevice: String(metadata.dev),
              workspaceInode: String(metadata.ino),
              supervisorId,
              containerId: existingContainer
            };
      const evidencePath = resolve(
        root,
        `.local/${runId}-${attempt.taskId}-${operation === '--abandon' ? 'abandonment' : 'recovery'}.json`
      );
      try {
        await readFile(evidencePath);
        throw new Error(
          'Saved recovery evidence already exists; do not mint a replacement settlement identity'
        );
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
      const attestation = await new WorkspaceRecoveryAttestor(
        observer.observer,
        'local-recovery',
        recoveryPrivate
      ).attest(generation);
      // Publish the exact signed evidence before a durable settlement binds its ID.
      // A failure afterward must retain this evidence rather than mint another ID.
      await writeFile(
        evidencePath,
        JSON.stringify(
          { generation, attestation, attemptFingerprint: attempt.leasePlanFingerprint },
          null,
          2
        ),
        { flag: 'wx', mode: 0o600 }
      );
      if (operation === '--abandon') {
        await handoff.abandon(generation, attestation);
        operatorRequest.writeOutput?.(
          JSON.stringify({ runId, taskId: attempt.taskId, status: 'setup-abandoned-no-child' })
        );
        continue;
      }
      await handoff.settle(generation, attestation);
      const child = await handoff.handoff(generation, attestation, attempt.leasePlanFingerprint);
      if ('blocked' in child) {
        throw new Error('Execution handoff blocked; no workflow started');
      }
      await writeFile(
        resolve(root, `.local/${runId}-${attempt.taskId}-setup.json`),
        JSON.stringify(
          {
            runId,
            taskId: attempt.taskId,
            scopeId,
            parentClaimId,
            generation,
            child
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      operatorRequest.writeOutput?.(
        JSON.stringify({
          runId,
          taskId: attempt.taskId,
          status: 'execution-child-ready'
        })
      );
    }
  } finally {
    await Promise.all(resources.map((close) => close()));
  }
}
