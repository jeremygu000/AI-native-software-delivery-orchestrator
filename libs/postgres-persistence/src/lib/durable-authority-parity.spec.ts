import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import postgres from 'postgres';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import {
  createPlanApproval,
  createWorkspaceSetupApproval,
  fingerprintPlanValue,
  workspaceSetupAuthorizationMessage
} from '@ai-native-software-delivery-orchestrator/planning';
import { ForgeReadModel } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import {
  taskLeasePlanFingerprint,
  taskVerificationEvidenceFingerprint,
  FencedMutationPort,
  type GlobalMutationClaim
} from '@ai-native-software-delivery-orchestrator/domain';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import {
  durableAuthorityContract,
  durableAuthorityInitialDispatch,
  durableAuthorityRepairAttempt,
  durableAuthorityRepairWorkItem,
  durableAuthorityRunRequest,
  type DurableAuthorityFixture
} from '../../../persistence/src/lib/durable-authority.contract.test.js';
import {
  globalMutationCutoverContract,
  globalMutationPermitContract,
  type GlobalMutationCutoverFixture,
  type GlobalMutationPermitFixture
} from '../../../persistence/src/lib/global-mutation-authority.contract.test.js';
import { approvalTestArtifact } from '../../../planning/src/lib/plan-artifact.fixture.js';
import { PostgresGlobalMutationAuthority } from './postgres-global-mutation-authority.js';
import { PostgresOrchestrationPersistence } from './postgres-orchestration-persistence.js';
import { PostgresWorkspaceSetupAdmission } from './postgres-workspace-setup-admission.js';
import {
  PostgresExecutionGenerationIssuer,
  PostgresTrustRegistryAdmin
} from './postgres-trust-writers.js';
import {
  assertPostgresAuthoritySchema,
  assertPostgresGlobalAuthoritySchema,
  migratePostgresAuthoritySchema,
  POSTGRES_AUTHORITY_SCHEMA_VERSION,
  POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
} from './postgres-authority-schema.js';

let directory: string;
let connectionString: string;
let role: string;
let runtimeRole: string;
let runtimeConnectionString: string;
let ownerConnectionString: string;
let trustAdminRole: string;
let generationIssuerRole: string;
let setupAdmissionRole: string;
let trustAdminConnectionString: string;
let generationIssuerConnectionString: string;
let setupAdmissionConnectionString: string;
const port = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('No PostgreSQL fixture port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'forge-postgres-authority-'));
  const data = join(directory, 'data');
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { stdio: 'pipe' });
  const assignedPort = await port();
  execFileSync(
    'pg_ctl',
    [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${assignedPort}`,
      '-w',
      'start'
    ],
    { stdio: 'pipe' }
  );
  connectionString = `postgresql://127.0.0.1:${assignedPort}/postgres`;
  const admin = postgres(connectionString, { onnotice: () => undefined });
  try {
    const identity = await admin`select current_user as name`;
    const adminRole = String(identity[0]?.name);
    role = `forge_migrator_${process.pid}`;
    runtimeRole = `forge_runtime_${process.pid}`;
    trustAdminRole = `forge_trust_admin_${process.pid}`;
    generationIssuerRole = `forge_generation_issuer_${process.pid}`;
    setupAdmissionRole = `forge_setup_admission_${process.pid}`;
    await admin.unsafe(`create role "${role}" login`);
    await admin.unsafe(`create role "${runtimeRole}" login`);
    await admin.unsafe(`create role "${trustAdminRole}" login`);
    await admin.unsafe(`create role "${generationIssuerRole}" login`);
    await admin.unsafe(`create role "${setupAdmissionRole}" login`);
    await admin`revoke create on database postgres from public`;
    await admin`revoke temporary on database postgres from public`;
    await admin`revoke create on schema public from public`;
    await admin.unsafe(`grant create on database postgres to "${role}"`);
    ownerConnectionString = `postgresql://${role}@127.0.0.1:${assignedPort}/postgres`;
    runtimeConnectionString = `postgresql://${runtimeRole}@127.0.0.1:${assignedPort}/postgres`;
    trustAdminConnectionString = `postgresql://${trustAdminRole}@127.0.0.1:${assignedPort}/postgres`;
    generationIssuerConnectionString = `postgresql://${generationIssuerRole}@127.0.0.1:${assignedPort}/postgres`;
    setupAdmissionConnectionString = `postgresql://${setupAdmissionRole}@127.0.0.1:${assignedPort}/postgres`;
    if (adminRole === role || adminRole === runtimeRole) {
      throw new Error('Fixture migration and runtime roles must not be superusers');
    }
  } finally {
    await admin.end();
  }
}, 90_000);

afterAll(() => {
  if (directory !== undefined) {
    try {
      execFileSync('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], {
        stdio: 'pipe'
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

let fixtureOrdinal = 0;
const createFixture = async (): Promise<DurableAuthorityFixture & { schema: string }> => {
  const schema = `forge_contract_${++fixtureOrdinal}`;
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const configuration = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  let store: PostgresOrchestrationPersistence | undefined;
  let peer: PostgresOrchestrationPersistence | undefined;
  try {
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema, role },
      runtimeRole
    );
    store = await PostgresOrchestrationPersistence.connect(configuration);
    peer = await PostgresOrchestrationPersistence.connect(configuration);
    return {
      store,
      peer,
      schema,
      corruptRecord: async (kind, key, transform) => {
        const rows = await admin.unsafe(
          `select payload from "${schema}".forge_records where run_id=$1 and kind=$2 and key=$3`,
          ['contract-run', kind, key]
        );
        if (rows.length !== 1 || typeof rows[0]?.payload !== 'string') {
          throw new Error(`Missing ${kind} corruption fixture: ${key}`);
        }
        const value: unknown = JSON.parse(rows[0].payload);
        await admin.unsafe(
          `update "${schema}".forge_records set payload=$4 where run_id=$1 and kind=$2 and key=$3`,
          ['contract-run', kind, key, JSON.stringify(transform(value))]
        );
      },
      removeRecord: async (kind, key) => {
        await admin.unsafe(
          `delete from "${schema}".forge_records where run_id=$1 and kind=$2 and key=$3`,
          ['contract-run', kind, key]
        );
      },
      close: async () => {
        await Promise.all([store.close(), peer.close()]);
        await admin.unsafe(`drop schema "${schema}" cascade`);
        await admin.end();
      }
    };
  } catch (error) {
    await Promise.all([store?.close(), peer?.close()]);
    await admin.end();
    throw error;
  }
};

durableAuthorityContract('PostgreSQL isolated server', createFixture);

const createGlobalPermitFixture = async (): Promise<
  GlobalMutationPermitFixture & {
    schema: string;
    admin: ReturnType<typeof postgres>;
    store: PostgresOrchestrationPersistence;
  }
> => {
  const schema = `forge_global_adapter_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  let peer: PostgresGlobalMutationAuthority | undefined;
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
      { trustAdminRole, generationIssuerRole, setupAdmissionRole }
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    peer = await PostgresGlobalMutationAuthority.connect(runtime);
    const scopeId = await authority.registerScope('contract-repository');
    await authority.beginLegacyCutover();
    await authority.completeLegacyCutover('The previous writers are stopped.');
    await authority.activateScope(scopeId);
    const runId = `global-run-${fixtureOrdinal}`;
    const request = durableAuthorityRunRequest(runId);
    await store.createRun(request);
    await expect(peer.recoverGlobalRunScope(runId)).rejects.toThrow('durable global scope binding');
    await authority.bindRun(runId, request.run.repositoryId);
    const binding = request.taskBindings[0];
    if (binding === undefined) {
      throw new Error('Missing global test binding');
    }
    for (const attemptId of ['original', 'replacement']) {
      await store.persistAttempt({
        runId,
        attempt: {
          id: attemptId,
          runId,
          taskId: 'task-1',
          agentId: 'agent-1',
          workspaceId: 'workspace-1',
          leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
          state: 'PREPARING',
          revision: 1
        }
      });
    }
    const originalClaim: GlobalMutationClaim = {
      scopeId,
      claimId: 'original-claim',
      owner: { runId, taskId: 'task-1', attemptId: 'original', agentId: 'agent-1' },
      resources: [{ type: 'project', projectId: 'project-1' }]
    };
    expect(await peer.recoverGlobalRunScope(runId)).toBe(scopeId);
    const originalGrant = await authority.claimGlobalMutation(originalClaim);
    if (originalGrant.status !== 'granted') {
      throw new Error('Fixture claim was not granted');
    }
    let ownerClosed = false;
    return {
      schema,
      admin,
      store,
      authority,
      peer,
      scopeId,
      originalClaim,
      originalGrant,
      replacementClaim: {
        ...originalClaim,
        claimId: 'replacement-claim',
        owner: { ...originalClaim.owner, attemptId: 'replacement' }
      },
      closeOwnerConnectionWithoutEnd: async () => {
        await authority.close();
        ownerClosed = true;
      },
      close: async () => {
        if (!ownerClosed) {
          await authority.close();
        }
        await peer.close();
        await store.close();
        await admin.unsafe(`drop schema "${schema}" cascade`);
        await admin.end();
      }
    };
  } catch (error) {
    await Promise.all([authority?.close(), peer?.close(), store?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
    throw error;
  }
};

globalMutationPermitContract('PostgreSQL isolated server', createGlobalPermitFixture);

const createTrustedSetupFixture = async () => {
  const fixture = await createGlobalPermitFixture();
  const artifact = approvalTestArtifact();
  const executionApproval = createPlanApproval({
    approvalId: 'execution-1',
    artifact,
    approvedBy: 'execution-reviewer',
    approvedAt: '2026-08-13T01:00:00.000Z'
  });
  const setupApproval = createWorkspaceSetupApproval({
    setupApprovalId: 'setup-1',
    artifact,
    executionApproval,
    taskId: 'task-a',
    approvedBy: 'setup-reviewer',
    approvedAt: '2026-08-13T02:00:00.000Z'
  });
  const keyId = 'trusted-setup-key';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const authorization = {
    schemaVersion: 1 as const,
    keyId,
    setupApprovalId: setupApproval.setupApprovalId,
    setupApprovalFingerprint: setupApproval.setupApprovalFingerprint,
    signature: sign(
      null,
      workspaceSetupAuthorizationMessage(setupApproval, keyId),
      privateKey
    ).toString('base64url')
  };
  const runId = `approved-setup-${fixture.schema}`;
  const base = durableAuthorityRunRequest(runId);
  const binding = base.taskBindings[0];
  const task = base.tasks[0];
  if (binding === undefined || task === undefined) {
    throw new Error('Missing setup fixture task');
  }
  await fixture.authority.registerAlias(fixture.scopeId, artifact.repository.repositoryId);
  await fixture.store.createRun({
    ...base,
    run: {
      ...base.run,
      repositoryId: artifact.repository.repositoryId,
      authority: {
        ...base.run.authority,
        artifactId: artifact.artifactId,
        artifactRevision: artifact.revision,
        approvalId: executionApproval.approvalId,
        planFingerprint: artifact.planFingerprint,
        approvalFingerprint: executionApproval.approvalFingerprint,
        repositoryRoot: artifact.repository.repositoryRoot,
        baseCommit: artifact.repository.baseCommit
      }
    },
    tasks: [{ ...task, id: setupApproval.taskId }],
    taskBindings: [
      {
        ...binding,
        taskId: setupApproval.taskId,
        leasePlan: { ...binding.leasePlan, taskId: setupApproval.taskId },
        workspace: {
          ...binding.workspace,
          taskId: setupApproval.taskId,
          id: 'approved-workspace',
          integrationRepositoryPath: artifact.repository.repositoryRoot
        }
      }
    ]
  });
  await fixture.authority.bindRun(runId, setupApproval.repositoryId);
  const approvedBinding = {
    ...binding,
    taskId: setupApproval.taskId,
    leasePlan: { ...binding.leasePlan, taskId: setupApproval.taskId },
    workspace: {
      ...binding.workspace,
      taskId: setupApproval.taskId,
      id: 'approved-workspace',
      integrationRepositoryPath: artifact.repository.repositoryRoot
    }
  };
  await fixture.store.persistAttempt({
    runId,
    attempt: {
      id: 'approved-setup-attempt',
      runId,
      taskId: setupApproval.taskId,
      agentId: approvedBinding.agentId,
      workspaceId: approvedBinding.workspace.id,
      leasePlanFingerprint: taskLeasePlanFingerprint(approvedBinding.leasePlan),
      state: 'PREPARING',
      revision: 1
    }
  });
  const trustAdmin = await PostgresTrustRegistryAdmin.connect({
    connectionString: trustAdminConnectionString,
    schema: fixture.schema,
    role: trustAdminRole
  });
  await trustAdmin.registerKey(keyId, publicKey.export({ type: 'spki', format: 'pem' }));
  await trustAdmin.setPolicyVersion('git-workspace-setup-v1');
  const request = {
    scopeId: fixture.scopeId,
    runId,
    workspaceId: 'approved-workspace',
    artifact,
    executionApproval,
    setupApproval,
    authorization
  };
  return {
    ...fixture,
    trustAdmin,
    request,
    approvedBinding,
    close: async () => {
      await trustAdmin.close();
      await fixture.close();
    }
  };
};

it('atomically admits a signed repository-only setup parent and INITIAL_ADMITTED marker', async () => {
  const fixture = await createTrustedSetupFixture();
  const admission = await PostgresWorkspaceSetupAdmission.connect({
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  });
  try {
    const request = {
      ...fixture.request,
      attemptId: 'approved-setup-attempt',
      parentClaimId: 'setup-parent-1',
      binding: fixture.approvedBinding
    };
    await expect(
      admission.admit({
        ...request,
        authorization: {
          ...request.authorization,
          signature: 'A'.repeat(86)
        }
      })
    ).rejects.toThrow();
    await expect(admission.admit({ ...request, workspaceId: 'wrong-workspace' })).rejects.toThrow(
      'binding does not match'
    );
    expect(
      await fixture.admin.unsafe(
        `select next_token from "${fixture.schema}".forge_global_scopes where id=$1`,
        [request.scopeId]
      )
    ).toMatchObject([{ next_token: '1' }]);
    const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
    const setupSql = postgres(setupAdmissionConnectionString, { onnotice: () => undefined });
    try {
      const permissions =
        await runtime`select has_function_privilege(current_user,p.oid,'EXECUTE') as execute
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=${fixture.schema} and p.proname='forge_setup_admit'`;
      expect(permissions).toMatchObject([{ execute: false }]);
      await expect(
        setupSql.unsafe(
          `update "${fixture.schema}".forge_global_workspace_phases set phase='WORKSPACE_ARMED'`
        )
      ).rejects.toThrow('permission denied');
    } finally {
      await Promise.all([runtime.end(), setupSql.end()]);
    }
    const blocked = await admission.admit(request);
    expect(blocked).toEqual({ status: 'blocked' });
    expect(
      await fixture.admin.unsafe(
        `select count(*)::integer as count from "${fixture.schema}".forge_global_workspace_phases`
      )
    ).toMatchObject([{ count: 0 }]);
    await fixture.authority.releaseGlobalMutation({
      ...fixture.originalClaim,
      token: fixture.originalGrant.token,
      expectedVersion: fixture.originalGrant.leases[0]?.version ?? 1,
      stopEvidence: 'The original actor is confirmed stopped.'
    });
    const granted = await admission.admit(request);
    expect(granted.status).toBe('granted');
    expect(await admission.admit(request)).toEqual(granted);
    await expect(admission.admit({ ...request, parentClaimId: 'other-parent' })).rejects.toThrow(
      'Only a preparing attempt'
    );
    expect(
      await fixture.admin.unsafe(
        `select phase,signing_key,authorization_digest from "${fixture.schema}".forge_global_workspace_phases`
      )
    ).toMatchObject([{ phase: 'INITIAL_ADMITTED', signing_key: 'trusted-setup-key' }]);
    expect(
      await fixture.admin.unsafe(
        `select resource_json from "${fixture.schema}".forge_global_leases where claim_id='setup-parent-1'`
      )
    ).toMatchObject([{ resource_json: '{"type":"repository"}' }]);
    await expect(
      fixture.peer.beginFencedMutation({
        scopeId: request.scopeId,
        claimId: request.parentClaimId,
        owner: {
          runId: request.runId,
          taskId: request.setupApproval.taskId,
          attemptId: request.attemptId,
          agentId: request.binding.agentId,
          workspaceId: request.workspaceId
        },
        token: granted.status === 'granted' ? granted.token : 0,
        resource: { type: 'repository' }
      })
    ).rejects.toThrow('Workspace setup parent forbids ordinary');
  } finally {
    await admission.close();
    await fixture.close();
  }
});

it('arms only an issued, unrevoked generation with current trust and never grants an ordinary Git permit', async () => {
  const fixture = await createTrustedSetupFixture();
  const admission = await PostgresWorkspaceSetupAdmission.connect({
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  });
  const issuer = await PostgresExecutionGenerationIssuer.connect({
    connectionString: generationIssuerConnectionString,
    schema: fixture.schema,
    role: generationIssuerRole
  });
  const request = {
    ...fixture.request,
    attemptId: 'approved-setup-attempt',
    parentClaimId: 'armed-parent',
    binding: fixture.approvedBinding,
    generationId: 'supervised-generation'
  };
  try {
    await fixture.authority.releaseGlobalMutation({
      ...fixture.originalClaim,
      token: fixture.originalGrant.token,
      expectedVersion: fixture.originalGrant.leases[0]?.version ?? 1,
      stopEvidence: 'The prior writer has stopped.'
    });
    expect((await admission.admit(request)).status).toBe('granted');
    await expect(admission.arm(request)).rejects.toThrow('parent or phase');
    const generation = {
      generationId: request.generationId,
      scopeId: request.scopeId,
      parentClaimId: request.parentClaimId,
      runId: request.runId,
      taskId: request.setupApproval.taskId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      supervisorId: 'supervisor-one',
      setupPlanDigest: request.setupApproval.setupApprovalFingerprint.slice(7),
      executionPlanDigest: fingerprintPlanValue(request.binding.leasePlan).slice(7)
    };
    await issuer.issue(generation);
    await expect(
      admission.arm({ ...request, generationId: 'unrelated-generation' })
    ).rejects.toThrow('parent or phase');
    const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
    try {
      const functionPrivilege =
        await runtime`select has_function_privilege(current_user,p.oid,'EXECUTE') as allowed
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=${fixture.schema} and p.proname='forge_setup_arm'`;
      expect(functionPrivilege).toMatchObject([{ allowed: false }]);
    } finally {
      await runtime.end();
    }
    await admission.arm(request);
    await admission.arm(request);
    expect(
      await fixture.admin.unsafe(
        `select phase,execution_generation from "${fixture.schema}".forge_global_workspace_phases where parent_claim_id=$1`,
        [request.parentClaimId]
      )
    ).toMatchObject([{ phase: 'WORKSPACE_ARMED', execution_generation: request.generationId }]);
    await expect(
      fixture.peer.beginFencedMutation({
        scopeId: request.scopeId,
        claimId: request.parentClaimId,
        owner: {
          runId: request.runId,
          taskId: request.setupApproval.taskId,
          attemptId: request.attemptId,
          agentId: request.binding.agentId,
          workspaceId: request.workspaceId
        },
        token: 2,
        resource: { type: 'repository' }
      })
    ).rejects.toThrow('Workspace setup parent forbids ordinary');
    await issuer.revoke(request.generationId, request.scopeId);
    await expect(admission.arm(request)).rejects.toThrow('execution generation');
    expect(
      await fixture.admin.unsafe(
        `select phase from "${fixture.schema}".forge_global_workspace_phases where parent_claim_id=$1`,
        [request.parentClaimId]
      )
    ).toMatchObject([{ phase: 'WORKSPACE_ARMED' }]);
  } finally {
    await Promise.all([admission.close(), issuer.close(), fixture.close()]);
  }
});

it('records at most one workspace Git permit lineage after arming without exposing a generic permit', async () => {
  const fixture = await createTrustedSetupFixture();
  const admission = await PostgresWorkspaceSetupAdmission.connect({
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  });
  const issuer = await PostgresExecutionGenerationIssuer.connect({
    connectionString: generationIssuerConnectionString,
    schema: fixture.schema,
    role: generationIssuerRole
  });
  const request = {
    ...fixture.request,
    parentClaimId: 'workspace-permit-parent',
    attemptId: 'approved-setup-attempt',
    generationId: 'workspace-permit-generation',
    supervisorId: 'workspace-permit-supervisor',
    binding: fixture.approvedBinding
  };
  const parentOwner = {
    runId: request.runId,
    taskId: request.setupApproval.taskId,
    attemptId: request.attemptId,
    agentId: request.binding.agentId,
    workspaceId: request.workspaceId
  };
  try {
    await fixture.authority.releaseGlobalMutation({
      ...fixture.originalClaim,
      token: fixture.originalGrant.token,
      expectedVersion: fixture.originalGrant.leases[0]?.version ?? 1,
      stopEvidence: 'The prior actor is confirmed stopped.'
    });
    const granted = await admission.admit(request);
    if (granted.status !== 'granted') {
      throw new Error('Setup parent must be granted');
    }
    const scoped = {
      ...request,
      token: granted.token,
      version: 1
    };
    await expect(admission.beginWorkspaceCreationPermit(scoped)).rejects.toThrow('not armed');
    expect(
      await fixture.admin.unsafe(
        `select count(*)::integer as count from "${fixture.schema}".forge_global_workspace_permit_lineages`
      )
    ).toMatchObject([{ count: 0 }]);
    await issuer.issue({
      generationId: request.generationId,
      scopeId: request.scopeId,
      parentClaimId: request.parentClaimId,
      runId: request.runId,
      taskId: request.setupApproval.taskId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      supervisorId: request.supervisorId,
      setupPlanDigest: request.setupApproval.setupApprovalFingerprint.slice(7),
      executionPlanDigest: fingerprintPlanValue(request.binding.leasePlan).slice(7)
    });
    await admission.arm(scoped);
    await expect(
      admission.beginWorkspaceCreationPermit({ ...scoped, supervisorId: 'wrong-supervisor' })
    ).rejects.toThrow('generation is not current');
    await expect(
      admission.beginWorkspaceCreationPermit({ ...scoped, version: scoped.version + 1 })
    ).rejects.toThrow('not armed');
    const permit = await admission.beginWorkspaceCreationPermit(scoped);
    expect(permit.id).toEqual(expect.any(String));
    expect(permit.completionSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await fixture.admin.unsafe(
        `select permit_id,verifier from "${fixture.schema}".forge_global_workspace_permit_lineages`
      )
    ).toMatchObject([{ permit_id: permit.id, verifier: expect.any(String) }]);
    const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
    try {
      const permissions = await runtime`select p.proname as name,
        has_function_privilege(current_user,p.oid,'EXECUTE') as allowed
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=${fixture.schema} and p.proname in
          ('forge_workspace_permit_begin','forge_workspace_permit_finish') order by p.proname`;
      expect(permissions).toMatchObject([
        { name: 'forge_workspace_permit_begin', allowed: false },
        { name: 'forge_workspace_permit_finish', allowed: false }
      ]);
    } finally {
      await runtime.end();
    }
    const peer = await PostgresWorkspaceSetupAdmission.connect({
      connectionString: setupAdmissionConnectionString,
      schema: fixture.schema,
      role: setupAdmissionRole
    });
    try {
      await expect(peer.beginWorkspaceCreationPermit(scoped)).rejects.toThrow('already exists');
    } finally {
      await peer.close();
    }
    await expect(
      fixture.peer.beginFencedMutation({
        scopeId: request.scopeId,
        claimId: request.parentClaimId,
        owner: parentOwner,
        token: granted.token,
        resource: { type: 'repository' }
      })
    ).rejects.toThrow('Workspace setup parent forbids ordinary');
    await expect(
      fixture.peer.releaseGlobalMutation({
        scopeId: request.scopeId,
        claimId: request.parentClaimId,
        owner: parentOwner,
        token: granted.token,
        expectedVersion: 1,
        stopEvidence: 'Not permitted.'
      })
    ).rejects.toThrow('Workspace setup parent forbids ordinary');
    await expect(
      admission.finishWorkspaceCreationPermit(
        { ...permit, completionSecret: 'invalid-secret' },
        'Git might have started'
      )
    ).rejects.toThrow('Invalid workspace Git completion capability');
    expect(
      await fixture.admin.unsafe(
        `select completed from "${fixture.schema}".forge_global_workspace_permit_lineages`
      )
    ).toMatchObject([{ completed: false }]);
    expect(
      await fixture.admin.unsafe(
        `select state from "${fixture.schema}".forge_global_claims where claim_id=$1`,
        [request.parentClaimId]
      )
    ).toMatchObject([{ state: 'ACTIVE' }]);
    await admission.finishWorkspaceCreationPermit(permit, 'Git outcome needs independent recovery');
    expect(
      await fixture.admin.unsafe(
        `select phase from "${fixture.schema}".forge_global_workspace_phases where parent_claim_id=$1`,
        [request.parentClaimId]
      )
    ).toMatchObject([{ phase: 'WORKSPACE_UNCERTAIN' }]);
    expect(
      await fixture.admin.unsafe(
        `select state from "${fixture.schema}".forge_global_claims where claim_id=$1`,
        [request.parentClaimId]
      )
    ).toMatchObject([{ state: 'HELD_UNCERTAIN' }]);
    await expect(
      admission.finishWorkspaceCreationPermit(permit, 'Duplicate finish')
    ).rejects.toThrow('Invalid workspace Git completion capability');
    await expect(admission.beginWorkspaceCreationPermit(scoped)).rejects.toThrow('not armed');
    await issuer.revoke(request.generationId, request.scopeId);
    await expect(admission.beginWorkspaceCreationPermit(scoped)).rejects.toThrow();
    expect(
      await fixture.admin.unsafe(
        `select count(*)::integer as count from "${fixture.schema}".forge_global_workspace_permit_lineages`
      )
    ).toMatchObject([{ count: 1 }]);
  } finally {
    await Promise.all([admission.close(), issuer.close(), fixture.close()]);
  }
});

it('leaves the exact Git permit unresolved if uncertainty cannot be recorded before callback completion', async () => {
  const fixture = await createTrustedSetupFixture();
  const admission = await PostgresWorkspaceSetupAdmission.connect({
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  });
  const issuer = await PostgresExecutionGenerationIssuer.connect({
    connectionString: generationIssuerConnectionString,
    schema: fixture.schema,
    role: generationIssuerRole
  });
  const request = {
    ...fixture.request,
    parentClaimId: 'failed-uncertainty-parent',
    attemptId: 'approved-setup-attempt',
    generationId: 'failed-uncertainty-generation',
    supervisorId: 'supervisor-one',
    binding: fixture.approvedBinding
  };
  try {
    await fixture.authority.releaseGlobalMutation({
      ...fixture.originalClaim,
      token: fixture.originalGrant.token,
      expectedVersion: fixture.originalGrant.leases[0]?.version ?? 1,
      stopEvidence: 'The original writer stopped.'
    });
    const result = await admission.admit(request);
    if (result.status !== 'granted') {
      throw new Error('Expected a setup parent');
    }
    await issuer.issue({
      generationId: request.generationId,
      scopeId: request.scopeId,
      parentClaimId: request.parentClaimId,
      runId: request.runId,
      taskId: request.setupApproval.taskId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      supervisorId: request.supervisorId,
      setupPlanDigest: request.setupApproval.setupApprovalFingerprint.slice(7),
      executionPlanDigest: fingerprintPlanValue(request.binding.leasePlan).slice(7)
    });
    await admission.arm(request);
    const scoped = { ...request, token: result.token, version: 1 };
    let calls = 0;
    await expect(
      admission.executeWorkspaceCreation(
        scoped,
        async () => {
          calls++;
          return 'workspace-created';
        },
        () => ''
      )
    ).rejects.toThrow('Workspace uncertainty evidence is required');
    expect(calls).toBe(1);
    expect(
      await fixture.admin.unsafe(
        `select phase from "${fixture.schema}".forge_global_workspace_phases where parent_claim_id=$1`,
        [request.parentClaimId]
      )
    ).toMatchObject([{ phase: 'WORKSPACE_ARMED' }]);
    expect(
      await fixture.admin.unsafe(
        `select completed from "${fixture.schema}".forge_global_workspace_permit_lineages`
      )
    ).toMatchObject([{ completed: false }]);
    await expect(
      admission.executeWorkspaceCreation(
        scoped,
        async () => {
          calls++;
        },
        () => 'Git outcome unknown'
      )
    ).rejects.toThrow('already exists');
    expect(calls).toBe(1);
  } finally {
    await Promise.all([admission.close(), issuer.close(), fixture.close()]);
  }
});

it('denies the dedicated Git callback if cancellation wins before permit begin', async () => {
  const fixture = await createTrustedSetupFixture();
  const admission = await PostgresWorkspaceSetupAdmission.connect({
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  });
  const issuer = await PostgresExecutionGenerationIssuer.connect({
    connectionString: generationIssuerConnectionString,
    schema: fixture.schema,
    role: generationIssuerRole
  });
  const request = {
    ...fixture.request,
    parentClaimId: 'cancel-before-git',
    attemptId: 'approved-setup-attempt',
    generationId: 'cancel-generation',
    supervisorId: 'supervisor-one',
    binding: fixture.approvedBinding
  };
  try {
    await fixture.authority.releaseGlobalMutation({
      ...fixture.originalClaim,
      token: fixture.originalGrant.token,
      expectedVersion: fixture.originalGrant.leases[0]?.version ?? 1,
      stopEvidence: 'Previous writer is stopped.'
    });
    const grant = await admission.admit(request);
    if (grant.status !== 'granted') {
      throw new Error('Expected setup parent');
    }
    await issuer.issue({
      generationId: request.generationId,
      scopeId: request.scopeId,
      parentClaimId: request.parentClaimId,
      runId: request.runId,
      taskId: request.setupApproval.taskId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      supervisorId: request.supervisorId,
      setupPlanDigest: request.setupApproval.setupApprovalFingerprint.slice(7),
      executionPlanDigest: fingerprintPlanValue(request.binding.leasePlan).slice(7)
    });
    await admission.arm(request);
    await fixture.store.updateRunState(request.runId, 'CANCEL_REQUESTED');
    let called = false;
    await expect(
      admission.executeWorkspaceCreation(
        { ...request, token: grant.token, version: 1 },
        async () => {
          called = true;
        },
        () => 'Git was cancelled'
      )
    ).rejects.toThrow('not active and bound');
    expect(called).toBe(false);
    expect(
      await fixture.admin.unsafe(
        `select count(*)::integer as count from "${fixture.schema}".forge_global_workspace_permit_lineages`
      )
    ).toMatchObject([{ count: 0 }]);
    expect(
      await fixture.admin.unsafe(
        `select phase from "${fixture.schema}".forge_global_workspace_phases where parent_claim_id=$1`,
        [request.parentClaimId]
      )
    ).toMatchObject([{ phase: 'WORKSPACE_ARMED' }]);
  } finally {
    await Promise.all([admission.close(), issuer.close(), fixture.close()]);
  }
});

it.each(['permit-first', 'revocation-first'] as const)(
  'serializes the dedicated Git permit and generation revocation (%s)',
  async (order) => {
    const fixture = await createTrustedSetupFixture();
    const admission = await PostgresWorkspaceSetupAdmission.connect({
      connectionString: setupAdmissionConnectionString,
      schema: fixture.schema,
      role: setupAdmissionRole
    });
    const issuer = await PostgresExecutionGenerationIssuer.connect({
      connectionString: generationIssuerConnectionString,
      schema: fixture.schema,
      role: generationIssuerRole
    });
    const blocker = postgres(ownerConnectionString, { onnotice: () => undefined });
    const request = {
      ...fixture.request,
      parentClaimId: `permit-revoke-${order}`,
      attemptId: 'approved-setup-attempt',
      generationId: `permit-revoke-generation-${order}`,
      supervisorId: 'controlled-supervisor',
      binding: fixture.approvedBinding
    };
    let release: (() => void) | undefined;
    let ready: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let held: Promise<unknown> | undefined;
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      await fixture.authority.releaseGlobalMutation({
        ...fixture.originalClaim,
        token: fixture.originalGrant.token,
        expectedVersion: fixture.originalGrant.leases[0]?.version ?? 1,
        stopEvidence: 'Prior actor stopped.'
      });
      const grant = await admission.admit(request);
      if (grant.status !== 'granted') {
        throw new Error('Expected the approved setup parent');
      }
      await issuer.issue({
        generationId: request.generationId,
        scopeId: request.scopeId,
        parentClaimId: request.parentClaimId,
        runId: request.runId,
        taskId: request.setupApproval.taskId,
        attemptId: request.attemptId,
        workspaceId: request.workspaceId,
        supervisorId: request.supervisorId,
        setupPlanDigest: request.setupApproval.setupApprovalFingerprint.slice(7),
        executionPlanDigest: fingerprintPlanValue(request.binding.leasePlan).slice(7)
      });
      await admission.arm(request);
      held = blocker.begin(async (tx) => {
        if (order === 'permit-first') {
          await tx.unsafe(`select id from "${fixture.schema}".forge_runs where id=$1 for update`, [
            request.runId
          ]);
        } else {
          await tx.unsafe(
            `select id from "${fixture.schema}".forge_global_generations where id=$1 for update`,
            [request.generationId]
          );
        }
        ready?.();
        await released;
      });
      await acquired;
      const scoped = { ...request, token: grant.token, version: 1 };
      if (order === 'permit-first') {
        first = admission.beginWorkspaceCreationPermit(scoped);
        void first.catch(() => undefined);
        const waiting = await blockedBackend(
          fixture.admin,
          fixture.schema,
          'forge-setup-admission',
          'forge_runs'
        );
        second = issuer.revoke(request.generationId, request.scopeId);
        const blocked = await blockedBackend(
          fixture.admin,
          fixture.schema,
          'forge-generation-issuer',
          'forge_global_scopes'
        );
        expect(blocked.blockers).toContain(waiting.pid);
      } else {
        first = issuer.revoke(request.generationId, request.scopeId);
        void first.catch(() => undefined);
        const waiting = await blockedBackend(
          fixture.admin,
          fixture.schema,
          'forge-generation-issuer',
          'forge_global_generations'
        );
        second = admission.beginWorkspaceCreationPermit(scoped);
        void second.catch(() => undefined);
        const blocked = await blockedBackend(
          fixture.admin,
          fixture.schema,
          'forge-setup-admission',
          'forge_global_scopes'
        );
        expect(blocked.blockers).toContain(waiting.pid);
      }
      release?.();
      await held;
      if (order === 'permit-first') {
        expect(first && (await first)).toMatchObject({ id: expect.any(String) });
        await second;
      } else {
        await first;
        await expect(second).rejects.toThrow('generation is not current');
      }
      expect(
        await fixture.admin.unsafe(
          `select count(*)::integer as count from "${fixture.schema}".forge_global_workspace_permit_lineages`
        )
      ).toMatchObject([{ count: order === 'permit-first' ? 1 : 0 }]);
      expect(
        await fixture.admin.unsafe(
          `select state from "${fixture.schema}".forge_global_generations where id=$1`,
          [request.generationId]
        )
      ).toMatchObject([{ state: 'REVOKED' }]);
    } finally {
      release?.();
      await Promise.allSettled([held, first, second]);
      await Promise.all([blocker.end(), admission.close(), issuer.close(), fixture.close()]);
    }
  },
  20_000
);

it.each(['trust-revoked', 'run-cancelled'] as const)(
  'refuses workspace arming after %s without changing the admitted parent',
  async (outcome) => {
    const fixture = await createTrustedSetupFixture();
    const admission = await PostgresWorkspaceSetupAdmission.connect({
      connectionString: setupAdmissionConnectionString,
      schema: fixture.schema,
      role: setupAdmissionRole
    });
    const issuer = await PostgresExecutionGenerationIssuer.connect({
      connectionString: generationIssuerConnectionString,
      schema: fixture.schema,
      role: generationIssuerRole
    });
    const request = {
      ...fixture.request,
      attemptId: 'approved-setup-attempt',
      parentClaimId: 'cancelled-parent',
      binding: fixture.approvedBinding,
      generationId: 'current-generation'
    };
    try {
      await fixture.authority.releaseGlobalMutation({
        ...fixture.originalClaim,
        token: fixture.originalGrant.token,
        expectedVersion: fixture.originalGrant.leases[0]?.version ?? 1,
        stopEvidence: 'The previous writer has stopped.'
      });
      expect((await admission.admit(request)).status).toBe('granted');
      await issuer.issue({
        generationId: request.generationId,
        scopeId: request.scopeId,
        parentClaimId: request.parentClaimId,
        runId: request.runId,
        taskId: request.setupApproval.taskId,
        attemptId: request.attemptId,
        workspaceId: request.workspaceId,
        supervisorId: 'supervisor-one',
        setupPlanDigest: request.setupApproval.setupApprovalFingerprint.slice(7),
        executionPlanDigest: fingerprintPlanValue(request.binding.leasePlan).slice(7)
      });
      if (outcome === 'trust-revoked') {
        await fixture.trustAdmin.revokeDecision(
          request.setupApproval.setupApprovalFingerprint.slice(7)
        );
      } else {
        await fixture.store.updateRunState(request.runId, 'CANCEL_REQUESTED');
      }
      await expect(admission.arm(request)).rejects.toThrow(
        outcome === 'trust-revoked' ? 'trust is not current' : 'run is not active'
      );
      expect(
        await fixture.admin.unsafe(
          `select phase from "${fixture.schema}".forge_global_workspace_phases where parent_claim_id=$1`,
          [request.parentClaimId]
        )
      ).toMatchObject([{ phase: 'INITIAL_ADMITTED' }]);
    } finally {
      await Promise.all([admission.close(), issuer.close(), fixture.close()]);
    }
  }
);

it('rejects arming if the persisted approved run identity changes after setup admission', async () => {
  const fixture = await createTrustedSetupFixture();
  const admission = await PostgresWorkspaceSetupAdmission.connect({
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  });
  const issuer = await PostgresExecutionGenerationIssuer.connect({
    connectionString: generationIssuerConnectionString,
    schema: fixture.schema,
    role: generationIssuerRole
  });
  const request = {
    ...fixture.request,
    attemptId: 'approved-setup-attempt',
    parentClaimId: 'changed-run-parent',
    binding: fixture.approvedBinding,
    generationId: 'changed-run-generation'
  };
  try {
    await fixture.authority.releaseGlobalMutation({
      ...fixture.originalClaim,
      token: fixture.originalGrant.token,
      expectedVersion: fixture.originalGrant.leases[0]?.version ?? 1,
      stopEvidence: 'The previous writer has stopped.'
    });
    expect((await admission.admit(request)).status).toBe('granted');
    await issuer.issue({
      generationId: request.generationId,
      scopeId: request.scopeId,
      parentClaimId: request.parentClaimId,
      runId: request.runId,
      taskId: request.setupApproval.taskId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      supervisorId: 'supervisor-one',
      setupPlanDigest: request.setupApproval.setupApprovalFingerprint.slice(7),
      executionPlanDigest: fingerprintPlanValue(request.binding.leasePlan).slice(7)
    });
    await fixture.admin.unsafe(
      `update "${fixture.schema}".forge_runs set payload=jsonb_set(payload::jsonb,'{run,authority,baseCommit}',to_jsonb('different-base'::text))::text where id=$1`,
      [request.runId]
    );
    await expect(admission.arm(request)).rejects.toThrow('run is not active and bound');
    expect(
      await fixture.admin.unsafe(
        `select phase from "${fixture.schema}".forge_global_workspace_phases where parent_claim_id=$1`,
        [request.parentClaimId]
      )
    ).toMatchObject([{ phase: 'INITIAL_ADMITTED' }]);
  } finally {
    await Promise.all([admission.close(), issuer.close(), fixture.close()]);
  }
});

it.each(['admission-first', 'revocation-first'] as const)(
  'serializes setup parent admission and signer revocation (%s) with no residual failed grant',
  async (order) => {
    const fixture = await createTrustedSetupFixture();
    const admission = await PostgresWorkspaceSetupAdmission.connect({
      connectionString: setupAdmissionConnectionString,
      schema: fixture.schema,
      role: setupAdmissionRole
    });
    const blocker = postgres(ownerConnectionString, { onnotice: () => undefined });
    const schema = fixture.schema;
    const request = {
      ...fixture.request,
      attemptId: 'approved-setup-attempt',
      parentClaimId: 'overlap-parent',
      binding: fixture.approvedBinding
    };
    let release: (() => void) | undefined;
    let ready: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let held: Promise<unknown> | undefined;
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      await fixture.authority.releaseGlobalMutation({
        ...fixture.originalClaim,
        token: fixture.originalGrant.token,
        expectedVersion: fixture.originalGrant.leases[0]?.version ?? 1,
        stopEvidence: 'The previous writer has stopped.'
      });
      held = blocker.begin(async (tx) => {
        if (order === 'admission-first') {
          await tx.unsafe(`lock table "${schema}".forge_global_scopes in access exclusive mode`);
        } else {
          await tx.unsafe(
            `select id from "${schema}".forge_global_trust_registry where id=1 for update`
          );
        }
        ready?.();
        await released;
      });
      await acquired;
      if (order === 'admission-first') {
        first = admission.admit(request);
        const waiting = await blockedBackend(
          fixture.admin,
          schema,
          'forge-setup-admission',
          'forge_global_scopes'
        );
        second = fixture.trustAdmin.revokeDecision(
          request.setupApproval.setupApprovalFingerprint.slice(7)
        );
        let blocked = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const rows = await fixture.admin`select pg_blocking_pids(pid) as blockers
            from pg_stat_activity where application_name='forge-trust-admin'
              and wait_event_type='Lock' and query like '%forge_trust_write%'`;
          if (
            rows.some((row) => Array.isArray(row.blockers) && row.blockers.includes(waiting.pid))
          ) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(true);
      } else {
        first = fixture.trustAdmin.revokeDecision(
          request.setupApproval.setupApprovalFingerprint.slice(7)
        );
        const waiting = await blockedBackend(
          fixture.admin,
          schema,
          'forge-trust-admin',
          'forge_global_trust_registry'
        );
        second = admission.admit(request);
        let blocked = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const rows = await fixture.admin`select pg_blocking_pids(pid) as blockers
            from pg_stat_activity where application_name='forge-setup-admission'
              and wait_event_type='Lock' and query like '%forge_setup_admit%'`;
          if (
            rows.some((row) => Array.isArray(row.blockers) && row.blockers.includes(waiting.pid))
          ) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(true);
      }
      release?.();
      await held;
      if (order === 'admission-first') {
        expect(first && (await first)).toMatchObject({ status: 'granted' });
        await second;
      } else {
        await first;
        await expect(second).rejects.toThrow('trust is not current');
      }
      const observer = await fixture.admin.unsafe(
        `select s.next_token, (select count(*)::integer from "${schema}".forge_global_workspace_phases
           where parent_claim_id='overlap-parent') as phases
         from "${schema}".forge_global_scopes s where s.id=$1`,
        [request.scopeId]
      );
      expect(observer).toMatchObject(
        order === 'admission-first'
          ? [{ next_token: '2', phases: 1 }]
          : [{ next_token: '1', phases: 0 }]
      );
      await expect(admission.admit(request)).rejects.toThrow('trust is not current');
    } finally {
      release?.();
      await held?.catch(() => undefined);
      await Promise.all([first?.catch(() => undefined), second?.catch(() => undefined)]);
      await Promise.all([blocker.end(), admission.close(), fixture.close()]);
    }
  },
  15_000
);

it('inspects signed setup approval against current registered trust and durable run identity without granting authority', async () => {
  const fixture = await createTrustedSetupFixture();
  try {
    const inspected = await fixture.peer.inspectCurrentWorkspaceSetupTrust(fixture.request);
    expect(inspected).toMatchObject({ registryRevision: 2, keyId: 'trusted-setup-key' });
    expect(inspected.decisionDigest).toHaveLength(64);
    expect(inspected.authorizationDigest).toHaveLength(64);
    await expect(
      fixture.peer.inspectCurrentWorkspaceSetupTrust({
        ...fixture.request,
        workspaceId: 'different-workspace'
      })
    ).rejects.toThrow('approved workspace identity');
    await expect(
      fixture.peer.inspectCurrentWorkspaceSetupTrust({
        ...fixture.request,
        runId: fixture.originalClaim.owner.runId
      })
    ).rejects.toThrow('persisted run approval');
    await expect(
      fixture.peer.inspectCurrentWorkspaceSetupTrust({
        ...fixture.request,
        authorization: { ...fixture.request.authorization, signature: 'A'.repeat(86) }
      })
    ).rejects.toThrow();
    expect(
      await fixture.admin.unsafe(
        `select count(*)::integer as count from "${fixture.schema}".forge_global_workspace_phases`
      )
    ).toMatchObject([{ count: 0 }]);
    expect(
      await fixture.admin.unsafe(
        `select count(*)::integer as count from "${fixture.schema}".forge_global_generations`
      )
    ).toMatchObject([{ count: 0 }]);
    const originalClaims = await fixture.peer.recoverRepositoryMutationAuthority(fixture.scopeId);
    expect(originalClaims).toHaveLength(1);
    await fixture.trustAdmin.revokeAuthorization(inspected.authorizationDigest);
    await expect(fixture.peer.inspectCurrentWorkspaceSetupTrust(fixture.request)).rejects.toThrow(
      'revoked'
    );
  } finally {
    await fixture.close();
  }
});

it.each(['key', 'decision', 'authorization', 'policy'] as const)(
  'serializes current setup trust inspection against %s revocation in both commit orders',
  async (change) => {
    const fixture = await createTrustedSetupFixture();
    const blocker = postgres(ownerConnectionString, { onnotice: () => undefined });
    let releaseScope: (() => void) | undefined;
    let scopeReady: (() => void) | undefined;
    const scopeReadySignal = new Promise<void>((resolve) => {
      scopeReady = resolve;
    });
    const scopeHeld = new Promise<void>((resolve) => {
      releaseScope = resolve;
    });
    const schema = fixture.schema;
    const initial = await fixture.peer.inspectCurrentWorkspaceSetupTrust(fixture.request);
    const heldScope = blocker.begin(async (tx) => {
      await tx.unsafe(`lock table "${schema}".forge_global_scopes in access exclusive mode`);
      scopeReady?.();
      await scopeHeld;
    });
    const changeTrust = async () => {
      if (change === 'key') {
        const key = await fixture.admin.unsafe(
          `select public_key from "${schema}".forge_global_trust_keys where key_id='trusted-setup-key'`
        );
        await fixture.trustAdmin.revokeKey('trusted-setup-key', String(key[0]?.public_key));
      } else if (change === 'decision') {
        await fixture.trustAdmin.revokeDecision(initial.decisionDigest);
      } else if (change === 'authorization') {
        await fixture.trustAdmin.revokeAuthorization(initial.authorizationDigest);
      } else {
        await fixture.trustAdmin.setPolicyVersion('disabled');
      }
    };
    let read: Promise<unknown> | undefined;
    let write: Promise<void> | undefined;
    try {
      await scopeReadySignal;
      read = fixture.peer.inspectCurrentWorkspaceSetupTrust(fixture.request);
      const waitingReader = await blockedBackend(
        fixture.admin,
        schema,
        'forge-global-authority',
        'forge_global_scopes'
      );
      write = changeTrust();
      let writerBlocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await fixture.admin`select pg_blocking_pids(pid) as blockers
          from pg_stat_activity where application_name='forge-trust-admin'
            and wait_event_type='Lock' and query like '%forge_trust_write%'`;
        if (
          rows.some(
            (row) => Array.isArray(row.blockers) && row.blockers.includes(waitingReader.pid)
          )
        ) {
          writerBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(writerBlocked).toBe(true);
      releaseScope?.();
      await heldScope;
      expect(await read).toEqual(initial);
      await write;
      await expect(
        fixture.peer.inspectCurrentWorkspaceSetupTrust(fixture.request)
      ).rejects.toThrow();
    } finally {
      releaseScope?.();
      await heldScope.catch(() => undefined);
      await Promise.all([read?.catch(() => undefined), write?.catch(() => undefined)]);
      await Promise.all([blocker.end(), fixture.close()]);
    }
  },
  15_000
);

it.each(['key', 'decision', 'authorization', 'policy'] as const)(
  'waits for an actual %s trust writer before inspecting current setup trust',
  async (change) => {
    const fixture = await createTrustedSetupFixture();
    const blocker = postgres(ownerConnectionString, { onnotice: () => undefined });
    const initial = await fixture.peer.inspectCurrentWorkspaceSetupTrust(fixture.request);
    const schema = fixture.schema;
    let releaseRegistry: (() => void) | undefined;
    let registryReady: (() => void) | undefined;
    const registryReadySignal = new Promise<void>((resolve) => {
      registryReady = resolve;
    });
    const registryHeld = new Promise<void>((resolve) => {
      releaseRegistry = resolve;
    });
    const heldRegistry = blocker.begin(async (tx) => {
      await tx.unsafe(
        `select id from "${schema}".forge_global_trust_registry where id=1 for update`
      );
      registryReady?.();
      await registryHeld;
    });
    const changeTrust = async () => {
      if (change === 'key') {
        const key = await fixture.admin.unsafe(
          `select public_key from "${schema}".forge_global_trust_keys where key_id='trusted-setup-key'`
        );
        await fixture.trustAdmin.revokeKey('trusted-setup-key', String(key[0]?.public_key));
      } else if (change === 'decision') {
        await fixture.trustAdmin.revokeDecision(initial.decisionDigest);
      } else if (change === 'authorization') {
        await fixture.trustAdmin.revokeAuthorization(initial.authorizationDigest);
      } else {
        await fixture.trustAdmin.setPolicyVersion('disabled');
      }
    };
    let write: Promise<void> | undefined;
    let read: Promise<unknown> | undefined;
    try {
      await registryReadySignal;
      write = changeTrust();
      const waitingWriter = await blockedBackend(
        fixture.admin,
        schema,
        'forge-trust-admin',
        'forge_global_trust_registry'
      );
      read = fixture.peer.inspectCurrentWorkspaceSetupTrust(fixture.request);
      let readerBlocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await fixture.admin`select pg_blocking_pids(pid) as blockers
          from pg_stat_activity where application_name='forge-global-authority'
            and wait_event_type='Lock' and query like '%pg_advisory_xact_lock_shared%'`;
        if (
          rows.some(
            (row) => Array.isArray(row.blockers) && row.blockers.includes(waitingWriter.pid)
          )
        ) {
          readerBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(readerBlocked).toBe(true);
      releaseRegistry?.();
      await heldRegistry;
      await write;
      await expect(read).rejects.toThrow();
    } finally {
      releaseRegistry?.();
      await heldRegistry.catch(() => undefined);
      await Promise.all([read?.catch(() => undefined), write?.catch(() => undefined)]);
      await Promise.all([blocker.end(), fixture.close()]);
    }
  },
  15_000
);

it('preserves owner-seeded generation rows across migration reruns without runtime write access', async () => {
  const fixture = await createGlobalPermitFixture();
  const migration = { connectionString: ownerConnectionString, schema: fixture.schema, role };
  try {
    await fixture.admin.unsafe(
      `insert into "${fixture.schema}".forge_global_generations
       (id,scope_id,parent_claim_id,run_id,task_id,attempt_id,workspace_id,
        supervisor_id,setup_plan_digest,execution_plan_digest,state)
       values ('generation-1',$1,$2,$3,$4,$5,'workspace-1','supervisor-1',
         'setup-digest','execution-digest','ISSUED')`,
      [
        fixture.scopeId,
        fixture.originalClaim.claimId,
        fixture.originalClaim.owner.runId,
        fixture.originalClaim.owner.taskId,
        fixture.originalClaim.owner.attemptId
      ]
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
      { trustAdminRole, generationIssuerRole, setupAdmissionRole }
    );
    expect(
      await fixture.admin.unsafe(
        `select id,state,scope_id,parent_claim_id from "${fixture.schema}".forge_global_generations`
      )
    ).toMatchObject([
      {
        id: 'generation-1',
        state: 'ISSUED',
        scope_id: fixture.scopeId,
        parent_claim_id: fixture.originalClaim.claimId
      }
    ]);
    const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
    try {
      await expect(
        runtime.unsafe(
          `update "${fixture.schema}".forge_global_generations set state='REVOKED' where id='generation-1'`
        )
      ).rejects.toThrow();
    } finally {
      await runtime.end();
    }
  } finally {
    await fixture.close();
  }
});

it('serializes a registry update before a scoped permit without granting runtime registry writes', async () => {
  const fixture = await createGlobalPermitFixture();
  const owner = postgres(ownerConnectionString, { onnotice: () => undefined });
  let release: (() => void) | undefined;
  let acquired: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registryLock = `forge-trust:"${fixture.schema}"`;
  const write = owner.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${registryLock}))`;
    acquired?.();
    await held;
    await tx.unsafe(
      `update "${fixture.schema}".forge_global_trust_registry set revision=revision+1, policy_version='policy-1' where id=1`
    );
    await tx.unsafe(
      `insert into "${fixture.schema}".forge_global_trust_keys (key_id,public_key,state)
       values ('key-1','test-public-key','ACTIVE')`
    );
  });
  try {
    await ready;
    const request = {
      scopeId: fixture.scopeId,
      claimId: fixture.originalClaim.claimId,
      owner: fixture.originalClaim.owner,
      token: fixture.originalGrant.token,
      resource: fixture.originalClaim.resources[0] ?? { type: 'repository' as const }
    };
    const permit = fixture.peer.beginFencedMutation(request);
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await fixture.admin`select pg_blocking_pids(pid) as blockers
        from pg_stat_activity where application_name='forge-global-authority'
          and wait_event_type='Lock' and query like '%pg_advisory_xact_lock_shared%'`;
      if (rows.length > 0) {
        const blockers: unknown = rows[0]?.blockers;
        expect(Array.isArray(blockers) && blockers.length > 0).toBe(true);
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
    release?.();
    await write;
    const capability = await permit;
    await fixture.peer.endFencedMutation(capability);
    expect(
      await fixture.admin.unsafe(
        `select revision,policy_version from "${fixture.schema}".forge_global_trust_registry`
      )
    ).toMatchObject([{ revision: '1', policy_version: 'policy-1' }]);
    expect(
      await fixture.admin.unsafe(
        `select key_id,state from "${fixture.schema}".forge_global_trust_keys`
      )
    ).toMatchObject([{ key_id: 'key-1', state: 'ACTIVE' }]);
  } finally {
    release?.();
    await write.catch(() => undefined);
    await owner.end();
    await fixture.close();
  }
});

it('holds a trust read through scoped permit commit before an administrator can revoke', async () => {
  const fixture = await createGlobalPermitFixture();
  const owner = postgres(ownerConnectionString, {
    connection: { application_name: 'forge-trust-admin' },
    onnotice: () => undefined
  });
  const blocker = postgres(ownerConnectionString, { onnotice: () => undefined });
  let release: (() => void) | undefined;
  let acquired: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = blocker.begin(async (tx) => {
    await tx.unsafe(`lock table "${fixture.schema}".forge_global_scopes in access exclusive mode`);
    acquired?.();
    await held;
  });
  try {
    await ready;
    const request = {
      scopeId: fixture.scopeId,
      claimId: fixture.originalClaim.claimId,
      owner: fixture.originalClaim.owner,
      token: fixture.originalGrant.token,
      resource: fixture.originalClaim.resources[0] ?? { type: 'repository' as const }
    };
    const permit = fixture.peer.beginFencedMutation(request);
    const waitingPermit = await blockedBackend(
      fixture.admin,
      fixture.schema,
      'forge-global-authority',
      'forge_global_scopes'
    );
    const writer = owner.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`forge-trust:"${fixture.schema}"`}))`;
      await tx.unsafe(
        `update "${fixture.schema}".forge_global_trust_registry set revision=revision+1 where id=1`
      );
      await tx.unsafe(
        `insert into "${fixture.schema}".forge_global_trust_revocations
         (kind,digest,registry_revision) values ('AUTHORIZATION','revoked-authorization',1)`
      );
    });
    let writerBlocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await fixture.admin`select pg_blocking_pids(pid) as blockers
        from pg_stat_activity where application_name='forge-trust-admin'
          and wait_event_type='Lock' and query like '%pg_advisory_xact_lock%'`;
      if (
        rows.some((row) => Array.isArray(row.blockers) && row.blockers.includes(waitingPermit.pid))
      ) {
        writerBlocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(writerBlocked).toBe(true);
    release?.();
    await locked;
    const capability = await permit;
    await writer;
    await fixture.peer.endFencedMutation(capability);
    expect(
      await fixture.admin.unsafe(
        `select revision from "${fixture.schema}".forge_global_trust_registry`
      )
    ).toMatchObject([{ revision: '1' }]);
    expect(
      await fixture.admin.unsafe(
        `select kind,digest,registry_revision from "${fixture.schema}".forge_global_trust_revocations`
      )
    ).toMatchObject([
      { kind: 'AUTHORIZATION', digest: 'revoked-authorization', registry_revision: '1' }
    ]);
  } finally {
    release?.();
    await locked.catch(() => undefined);
    await Promise.all([owner.end(), blocker.end(), fixture.close()]);
  }
}, 15_000);

it('restricts trust writes to the administrator function and preserves key identities across retries', async () => {
  const fixture = await createGlobalPermitFixture();
  const trustConfiguration = {
    connectionString: trustAdminConnectionString,
    schema: fixture.schema,
    role: trustAdminRole
  };
  const admin = await PostgresTrustRegistryAdmin.connect(trustConfiguration);
  const direct = postgres(trustAdminConnectionString, { onnotice: () => undefined });
  const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'pem'
  });
  const replacementKey = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'pem'
  });
  try {
    await expect(
      direct.unsafe(`update "${fixture.schema}".forge_global_trust_registry
      set policy_version='forged'`)
    ).rejects.toThrow();
    await expect(
      direct.unsafe(
        `select "${fixture.schema}".forge_generation_write(
      'REVOKE','missing',$1,null,null,null,null,null,null,null,null)`,
        [fixture.scopeId]
      )
    ).rejects.toThrow();
    await expect(
      runtime.unsafe(`select "${fixture.schema}".forge_trust_write(
      'REGISTER_KEY','forged','forged')`)
    ).rejects.toThrow();
    await fixture.admin
      .unsafe(`grant execute on function "${fixture.schema}".forge_trust_write(text,text,text)
      to "${runtimeRole}"`);
    const runtimeConfig = {
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    };
    await expect(assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig)).rejects.toThrow(
      'restricted authority writer functions are incompatible'
    );
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema: fixture.schema, role },
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
      { trustAdminRole, generationIssuerRole, setupAdmissionRole }
    );
    await assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig);
    expect(await admin.registerKey('key-1', publicKey)).toBe(1);
    expect(await admin.registerKey('key-1', publicKey)).toBe(1);
    await expect(admin.registerKey('key-1', replacementKey)).rejects.toThrow();
    expect(await admin.setPolicyVersion('policy-1')).toBe(2);
    expect(await admin.retireKey('key-1', publicKey)).toBe(3);
    await expect(admin.registerKey('key-1', publicKey)).rejects.toThrow();
    expect(await admin.revokeKey('key-1', publicKey)).toBe(4);
    await expect(admin.registerKey('key-1', publicKey)).rejects.toThrow();
    await expect(admin.revokeKey('key-1', replacementKey)).rejects.toThrow();
    expect(await admin.revokeDecision('a'.repeat(64))).toBe(5);
    expect(await admin.revokeDecision('a'.repeat(64))).toBe(5);
    expect(await admin.revokeAuthorization('b'.repeat(64))).toBe(6);
    expect(
      await fixture.admin.unsafe(`select revision,policy_version
      from "${fixture.schema}".forge_global_trust_registry`)
    ).toMatchObject([{ revision: '6', policy_version: 'policy-1' }]);
    expect(
      await fixture.admin.unsafe(`select kind,registry_revision
      from "${fixture.schema}".forge_global_trust_revocations order by registry_revision`)
    ).toMatchObject([
      { kind: 'DECISION', registry_revision: '5' },
      { kind: 'AUTHORIZATION', registry_revision: '6' }
    ]);
    await expect(
      PostgresTrustRegistryAdmin.connect({
        ...trustConfiguration,
        connectionString: runtimeConnectionString,
        role: runtimeRole
      })
    ).rejects.toThrow();
  } finally {
    await Promise.all([admin.close(), direct.end(), runtime.end()]);
    await fixture.close();
  }
});

it('rejects direct writer grants on base authority tables and repairs them on migration rerun', async () => {
  const fixture = await createGlobalPermitFixture();
  const migration = { connectionString: ownerConnectionString, schema: fixture.schema, role };
  const issuerConfig = {
    connectionString: generationIssuerConnectionString,
    schema: fixture.schema,
    role: generationIssuerRole
  };
  const direct = postgres(generationIssuerConnectionString, { onnotice: () => undefined });
  try {
    for (const [table, privilege] of [
      ['forge_runs', 'UPDATE'],
      ['forge_records', 'INSERT'],
      ['forge_schema_migrations', 'UPDATE']
    ]) {
      await fixture.admin.unsafe(
        `grant ${privilege} on "${fixture.schema}".${table} to "${generationIssuerRole}"`
      );
      await expect(PostgresExecutionGenerationIssuer.connect(issuerConfig)).rejects.toThrow(
        'direct table mutation privileges'
      );
      const runtimeSql = postgres(runtimeConnectionString, { onnotice: () => undefined });
      try {
        await expect(
          assertPostgresGlobalAuthoritySchema(runtimeSql, {
            connectionString: runtimeConnectionString,
            schema: fixture.schema,
            role: runtimeRole
          })
        ).rejects.toThrow('direct table mutation privileges');
      } finally {
        await runtimeSql.end();
      }
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
        {
          trustAdminRole,
          generationIssuerRole,
          setupAdmissionRole
        }
      );
      const issuer = await PostgresExecutionGenerationIssuer.connect(issuerConfig);
      await issuer.close();
      const granted = await direct.unsafe(
        `select has_table_privilege(current_user,'"${fixture.schema}".${table}',$1) as allowed`,
        [privilege]
      );
      expect(granted[0]?.allowed).toBe(false);
    }
    await fixture.admin.unsafe(
      `grant update (state) on "${fixture.schema}".forge_runs to "${generationIssuerRole}"`
    );
    await expect(PostgresExecutionGenerationIssuer.connect(issuerConfig)).rejects.toThrow(
      'direct table mutation privileges'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
      {
        trustAdminRole,
        generationIssuerRole,
        setupAdmissionRole
      }
    );
    const column = await direct.unsafe(
      `select has_column_privilege(current_user,'"${fixture.schema}".forge_runs','state','UPDATE') as allowed`
    );
    expect(column[0]?.allowed).toBe(false);
  } finally {
    await Promise.all([direct.end(), fixture.close()]);
  }
});

it.each([
  ['TRIGGER', 'forge_global_scopes'],
  ['REFERENCES', 'forge_global_aliases']
] as const)(
  'rejects setup admission %s on %s and repairs table drift',
  async (privilege, table) => {
    const fixture = await createGlobalPermitFixture();
    const migration = { connectionString: ownerConnectionString, schema: fixture.schema, role };
    const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
    const setup = postgres(setupAdmissionConnectionString, { onnotice: () => undefined });
    const runtimeConfig = {
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    };
    const setupConfig = {
      connectionString: setupAdmissionConnectionString,
      schema: fixture.schema,
      role: setupAdmissionRole
    };
    try {
      await fixture.admin.unsafe(
        `grant ${privilege} on "${fixture.schema}".${table} to "${setupAdmissionRole}"`
      );
      const leaked = await setup.unsafe(
        `select has_table_privilege(current_user,'"${fixture.schema}".${table}',$1) as allowed`,
        [privilege]
      );
      expect(leaked[0]?.allowed).toBe(true);
      await expect(PostgresWorkspaceSetupAdmission.connect(setupConfig)).rejects.toThrow(
        'restricted signing-service login'
      );
      await expect(assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig)).rejects.toThrow(
        'direct table writes'
      );
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
        { trustAdminRole, generationIssuerRole, setupAdmissionRole }
      );
      const repaired = await setup.unsafe(
        `select has_table_privilege(current_user,'"${fixture.schema}".${table}',$1) as allowed`,
        [privilege]
      );
      expect(repaired[0]?.allowed).toBe(false);
      await assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig);
    } finally {
      await Promise.all([runtime.end(), setup.end(), fixture.close()]);
    }
  }
);

it('rejects setup admission column REFERENCES even after table-level migration repair', async () => {
  const fixture = await createGlobalPermitFixture();
  const migration = { connectionString: ownerConnectionString, schema: fixture.schema, role };
  const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
  const setup = postgres(setupAdmissionConnectionString, { onnotice: () => undefined });
  const runtimeConfig = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  const setupConfig = {
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  };
  try {
    await fixture.admin.unsafe(
      `grant references (scope_id) on "${fixture.schema}".forge_global_aliases to "${setupAdmissionRole}"`
    );
    const leaked = await setup.unsafe(
      `select has_column_privilege(current_user,'"${fixture.schema}".forge_global_aliases','scope_id','REFERENCES') as allowed`
    );
    expect(leaked[0]?.allowed).toBe(true);
    await expect(PostgresWorkspaceSetupAdmission.connect(setupConfig)).rejects.toThrow(
      'restricted signing-service login'
    );
    await expect(assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig)).rejects.toThrow(
      'direct table writes'
    );
    const acl = await fixture.admin.unsafe(
      `select a.attacl from pg_attribute a where a.attrelid='"${fixture.schema}".forge_global_aliases'::regclass and a.attname='scope_id'`
    );
    expect(acl[0]?.attacl).not.toBeNull();
    const granted = await fixture.admin.unsafe(
      `select acl.grantee::regrole::text as grantee, acl.privilege_type as privilege
       from pg_attribute a cross join lateral aclexplode(a.attacl) acl
       where a.attrelid='"${fixture.schema}".forge_global_aliases'::regclass and a.attname='scope_id'`
    );
    expect(granted).toContainEqual(
      expect.objectContaining({ grantee: setupAdmissionRole, privilege: 'REFERENCES' })
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
      { trustAdminRole, generationIssuerRole, setupAdmissionRole }
    );
    const after = await setup.unsafe(
      `select has_column_privilege(current_user,'"${fixture.schema}".forge_global_aliases','scope_id','REFERENCES') as allowed`
    );
    expect(after[0]?.allowed).toBe(false);
    await fixture.admin.unsafe(
      `revoke references (scope_id) on "${fixture.schema}".forge_global_aliases from "${setupAdmissionRole}"`
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
      { trustAdminRole, generationIssuerRole, setupAdmissionRole }
    );
    await assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig);
  } finally {
    await Promise.all([runtime.end(), setup.end(), fixture.close()]);
  }
});

it('rejects setup admission schema CREATE and removes the drift on migration rerun', async () => {
  const fixture = await createGlobalPermitFixture();
  const migration = { connectionString: ownerConnectionString, schema: fixture.schema, role };
  const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
  const setup = postgres(setupAdmissionConnectionString, { onnotice: () => undefined });
  const runtimeConfig = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  const setupConfig = {
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  };
  try {
    await fixture.admin.unsafe(
      `grant create on schema "${fixture.schema}" to "${setupAdmissionRole}"`
    );
    const leaked = await setup.unsafe(
      `select has_schema_privilege(current_user,$1,'CREATE') as allowed`,
      [fixture.schema]
    );
    expect(leaked[0]?.allowed).toBe(true);
    await expect(PostgresWorkspaceSetupAdmission.connect(setupConfig)).rejects.toThrow(
      'restricted signing-service login'
    );
    await expect(assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig)).rejects.toThrow(
      'schema CREATE privileges'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
      { trustAdminRole, generationIssuerRole, setupAdmissionRole }
    );
    const repaired = await setup.unsafe(
      `select has_schema_privilege(current_user,$1,'CREATE') as allowed`,
      [fixture.schema]
    );
    expect(repaired[0]?.allowed).toBe(false);
    await assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig);
  } finally {
    await Promise.all([runtime.end(), setup.end(), fixture.close()]);
  }
});

it('rejects setup admission CREATE on another accessible schema without silently repairing it', async () => {
  const fixture = await createGlobalPermitFixture();
  const other = `forge_setup_extra_${++fixtureOrdinal}`;
  const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
  const runtimeConfig = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    await fixture.admin.unsafe(`create schema "${other}"`);
    await fixture.admin.unsafe(`grant create on schema "${other}" to "${setupAdmissionRole}"`);
    await expect(
      PostgresWorkspaceSetupAdmission.connect({
        connectionString: setupAdmissionConnectionString,
        schema: fixture.schema,
        role: setupAdmissionRole
      })
    ).rejects.toThrow('restricted signing-service login');
    await expect(assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig)).rejects.toThrow(
      'schema CREATE privileges'
    );
    await expect(
      migratePostgresAuthoritySchema(
        { connectionString: ownerConnectionString, schema: fixture.schema, role },
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
        { trustAdminRole, generationIssuerRole, setupAdmissionRole }
      )
    ).rejects.toThrow('schema CREATE privileges');
    await fixture.admin.unsafe(`revoke create on schema "${other}" from "${setupAdmissionRole}"`);
    await assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig);
  } finally {
    await fixture.admin.unsafe(`revoke create on schema "${other}" from "${setupAdmissionRole}"`);
    await fixture.admin.unsafe(`drop schema if exists "${other}"`);
    await Promise.all([runtime.end(), fixture.close()]);
  }
});

it('rejects setup admission CREATE on pg_catalog until the database administrator revokes it', async () => {
  const fixture = await createGlobalPermitFixture();
  const setup = postgres(setupAdmissionConnectionString, { onnotice: () => undefined });
  const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
  const setupConfig = {
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  };
  const runtimeConfig = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    await fixture.admin.unsafe(`grant create on schema pg_catalog to "${setupAdmissionRole}"`);
    const leaked =
      await setup`select has_schema_privilege(current_user,'pg_catalog','CREATE') as allowed`;
    expect(leaked[0]?.allowed).toBe(true);
    await expect(PostgresWorkspaceSetupAdmission.connect(setupConfig)).rejects.toThrow(
      'restricted signing-service login'
    );
    await expect(assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig)).rejects.toThrow(
      'schema CREATE privileges'
    );
    await expect(
      migratePostgresAuthoritySchema(
        { connectionString: ownerConnectionString, schema: fixture.schema, role },
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
        { trustAdminRole, generationIssuerRole, setupAdmissionRole }
      )
    ).rejects.toThrow('schema CREATE privileges');
    await fixture.admin.unsafe(`revoke create on schema pg_catalog from "${setupAdmissionRole}"`);
    await assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig);
    const admitted = await PostgresWorkspaceSetupAdmission.connect(setupConfig);
    await admitted.close();
  } finally {
    await fixture.admin.unsafe(`revoke create on schema pg_catalog from "${setupAdmissionRole}"`);
    await Promise.all([setup.end(), runtime.end(), fixture.close()]);
  }
});

it.each([
  ['trust registry', 'forge_trust_write(text,text,text)'],
  [
    'execution generation',
    'forge_generation_write(text,text,text,text,text,text,text,text,text,text,text)'
  ]
] as const)('rejects setup admission EXECUTE on the %s writer', async (_label, signature) => {
  const fixture = await createGlobalPermitFixture();
  const setup = postgres(setupAdmissionConnectionString, { onnotice: () => undefined });
  const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
  const setupConfig = {
    connectionString: setupAdmissionConnectionString,
    schema: fixture.schema,
    role: setupAdmissionRole
  };
  const runtimeConfig = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    await fixture.admin.unsafe(
      `grant execute on function "${fixture.schema}".${signature} to "${setupAdmissionRole}"`
    );
    const leaked = await setup.unsafe(
      `select has_function_privilege(current_user,'"${fixture.schema}".${signature}','EXECUTE') as allowed`
    );
    expect(leaked[0]?.allowed).toBe(true);
    await expect(PostgresWorkspaceSetupAdmission.connect(setupConfig)).rejects.toThrow(
      'restricted signing-service login'
    );
    await expect(assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig)).rejects.toThrow(
      'restricted authority writer functions are incompatible'
    );
    await expect(
      migratePostgresAuthoritySchema(
        { connectionString: ownerConnectionString, schema: fixture.schema, role },
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
        { trustAdminRole, generationIssuerRole, setupAdmissionRole }
      )
    ).rejects.toThrow('restricted authority writer functions are incompatible');
    await fixture.admin.unsafe(
      `revoke execute on function "${fixture.schema}".${signature} from "${setupAdmissionRole}"`
    );
    await assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig);
    const admitted = await PostgresWorkspaceSetupAdmission.connect(setupConfig);
    await admitted.close();
  } finally {
    await fixture.admin.unsafe(
      `revoke execute on function "${fixture.schema}".${signature} from "${setupAdmissionRole}"`
    );
    await Promise.all([setup.end(), runtime.end(), fixture.close()]);
  }
});

it('rejects outsider EXECUTE on security-definer functions at startup and migration', async () => {
  const fixture = await createGlobalPermitFixture();
  const outsider = `forge_outsider_${++fixtureOrdinal}`;
  const runtime = postgres(runtimeConnectionString, { onnotice: () => undefined });
  const runtimeConfig = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    await fixture.admin.unsafe(`create role "${outsider}" login`);
    await fixture.admin.unsafe(`grant usage on schema "${fixture.schema}" to "${outsider}"`);
    await fixture.admin.unsafe(
      `grant execute on function "${fixture.schema}".forge_trust_write(text,text,text) to "${outsider}"`
    );
    await expect(assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig)).rejects.toThrow(
      'restricted authority writer functions are incompatible'
    );
    await expect(
      migratePostgresAuthoritySchema(
        { connectionString: ownerConnectionString, schema: fixture.schema, role },
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
        { trustAdminRole, generationIssuerRole, setupAdmissionRole }
      )
    ).rejects.toThrow('restricted authority writer functions are incompatible');
    await fixture.admin.unsafe(
      `revoke execute on function "${fixture.schema}".forge_trust_write(text,text,text) from "${outsider}"`
    );
    await assertPostgresGlobalAuthoritySchema(runtime, runtimeConfig);
  } finally {
    await runtime.end();
    await fixture.admin.unsafe(`revoke usage on schema "${fixture.schema}" from "${outsider}"`);
    await fixture.admin.unsafe(`drop role "${outsider}"`);
    await fixture.close();
  }
});

it.each([
  ['trust administrator', 'trust'],
  ['generation issuer', 'generation']
] as const)(
  'rejects inherited %s authority through role membership at startup and migration',
  async (_label, kind) => {
    const fixture = await createGlobalPermitFixture();
    const outsider = `forge_member_${++fixtureOrdinal}`;
    const writer = kind === 'trust' ? trustAdminRole : generationIssuerRole;
    const signature =
      kind === 'trust'
        ? `"${fixture.schema}".forge_trust_write(text,text,text)`
        : `"${fixture.schema}".forge_generation_write(text,text,text,text,text,text,text,text,text,text,text)`;
    const outsiderUrl = new URL(connectionString);
    outsiderUrl.username = outsider;
    const outsiderSql = postgres(outsiderUrl.toString(), { onnotice: () => undefined });
    const runtimeSql = postgres(runtimeConnectionString, { onnotice: () => undefined });
    const runtimeConfig = {
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    };
    const migration = { connectionString: ownerConnectionString, schema: fixture.schema, role };
    const roles = { trustAdminRole, generationIssuerRole, setupAdmissionRole };
    try {
      await fixture.admin.unsafe(`create role "${outsider}" login`);
      await fixture.admin.unsafe(`grant "${writer}" to "${outsider}"`);
      const inherited = await outsiderSql.unsafe(
        `select has_function_privilege(current_user,$1,'EXECUTE') as allowed`,
        [signature]
      );
      expect(inherited[0]?.allowed).toBe(true);
      await outsiderSql.begin(async (tx) => {
        await tx.unsafe(`set local role "${writer}"`);
        const assumed = await tx`select current_user as name`;
        expect(assumed[0]?.name).toBe(writer);
      });
      if (kind === 'trust') {
        await outsiderSql.begin(async (tx) => {
          await tx.unsafe(`set local role "${writer}"`);
          const revision = await tx.unsafe(
            `select "${fixture.schema}".forge_trust_write('SET_POLICY','policy','inherited-policy') as revision`
          );
          expect(revision[0]?.revision).toBe('1');
        });
      } else {
        await expect(
          outsiderSql.unsafe(
            `select "${fixture.schema}".forge_generation_write(
              'INVALID','inherited-id',$1,null,null,null,null,null,null,null,null)`,
            [fixture.scopeId]
          )
        ).rejects.toThrow('Unsupported generation operation');
      }
      await expect(
        kind === 'trust'
          ? PostgresTrustRegistryAdmin.connect({
              connectionString: trustAdminConnectionString,
              schema: fixture.schema,
              role: trustAdminRole
            })
          : PostgresExecutionGenerationIssuer.connect({
              connectionString: generationIssuerConnectionString,
              schema: fixture.schema,
              role: generationIssuerRole
            })
      ).rejects.toThrow('restricted login');
      await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtimeConfig)).rejects.toThrow(
        'writer role membership is incompatible'
      );
      await expect(
        migratePostgresAuthoritySchema(
          migration,
          runtimeRole,
          POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
          roles
        )
      ).rejects.toThrow('writer role membership is incompatible');
      await fixture.admin.unsafe(`revoke "${writer}" from "${outsider}"`);
      await assertPostgresGlobalAuthoritySchema(runtimeSql, runtimeConfig);

      await fixture.admin.unsafe(`grant "${outsider}" to "${writer}"`);
      await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtimeConfig)).rejects.toThrow(
        'writer role membership is incompatible'
      );
      await expect(
        migratePostgresAuthoritySchema(
          migration,
          runtimeRole,
          POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
          roles
        )
      ).rejects.toThrow('writer role membership is incompatible');
      await fixture.admin.unsafe(`revoke "${outsider}" from "${writer}"`);
      await assertPostgresGlobalAuthoritySchema(runtimeSql, runtimeConfig);
      const connected =
        kind === 'trust'
          ? await PostgresTrustRegistryAdmin.connect({
              connectionString: trustAdminConnectionString,
              schema: fixture.schema,
              role: trustAdminRole
            })
          : await PostgresExecutionGenerationIssuer.connect({
              connectionString: generationIssuerConnectionString,
              schema: fixture.schema,
              role: generationIssuerRole
            });
      await connected.close();
    } finally {
      await Promise.all([outsiderSql.end(), runtimeSql.end()]);
      await fixture.admin.unsafe(`revoke "${writer}" from "${outsider}"`);
      await fixture.admin.unsafe(`revoke "${outsider}" from "${writer}"`);
      await fixture.admin.unsafe(`drop role "${outsider}"`);
      await fixture.close();
    }
  }
);

it('issues one exact live generation and revokes it without worker table write access', async () => {
  const fixture = await createGlobalPermitFixture();
  const issuer = await PostgresExecutionGenerationIssuer.connect({
    connectionString: generationIssuerConnectionString,
    schema: fixture.schema,
    role: generationIssuerRole
  });
  const outsider = postgres(generationIssuerConnectionString, { onnotice: () => undefined });
  const binding = {
    generationId: 'generation-one',
    scopeId: fixture.scopeId,
    parentClaimId: fixture.originalClaim.claimId,
    runId: fixture.originalClaim.owner.runId,
    taskId: fixture.originalClaim.owner.taskId,
    attemptId: fixture.originalClaim.owner.attemptId,
    workspaceId: 'workspace-1',
    supervisorId: 'supervisor-one',
    setupPlanDigest: 'a'.repeat(64),
    executionPlanDigest: 'b'.repeat(64)
  };
  try {
    await fixture.admin.unsafe(
      `update "${fixture.schema}".forge_global_claims
      set owner_json=$3 where scope_id=$1 and claim_id=$2`,
      [
        fixture.scopeId,
        binding.parentClaimId,
        JSON.stringify({
          ...fixture.originalClaim.owner,
          workspaceId: binding.workspaceId
        })
      ]
    );
    await fixture.admin.unsafe(
      `insert into "${fixture.schema}".forge_global_workspace_phases
      (scope_id,parent_claim_id,phase,workspace_id,setup_plan_digest,execution_plan_digest)
      values ($1,$2,'INITIAL_ADMITTED',$3,$4,$5)`,
      [
        fixture.scopeId,
        binding.parentClaimId,
        binding.workspaceId,
        binding.setupPlanDigest,
        binding.executionPlanDigest
      ]
    );
    await expect(
      outsider.unsafe(`update "${fixture.schema}".forge_global_generations
      set state='REVOKED'`)
    ).rejects.toThrow();
    await expect(
      outsider.unsafe(`select "${fixture.schema}".forge_trust_write(
      'REGISTER_KEY','forged','forged')`)
    ).rejects.toThrow();
    await issuer.issue(binding);
    await issuer.issue(binding);
    await expect(issuer.issue({ ...binding, generationId: 'generation-two' })).rejects.toThrow();
    await expect(issuer.issue({ ...binding, supervisorId: 'other-supervisor' })).rejects.toThrow();
    const persisted = await fixture.admin.unsafe(
      `select id,state from "${fixture.schema}".forge_global_generations`
    );
    expect(persisted).toMatchObject([{ id: binding.generationId, state: 'ISSUED' }]);
    await issuer.revoke(binding.generationId, binding.scopeId);
    await issuer.revoke(binding.generationId, binding.scopeId);
    await expect(issuer.issue(binding)).rejects.toThrow();
    await expect(issuer.issue({ ...binding, generationId: 'generation-two' })).rejects.toThrow();
    expect(
      await fixture.admin.unsafe(`select state from "${fixture.schema}".forge_global_generations`)
    ).toMatchObject([{ state: 'REVOKED' }]);
  } finally {
    await issuer.close();
    await outsider.end();
    await fixture.close();
  }
});

it('serializes the restricted trust writer against scoped permit transactions in both winner orders', async () => {
  const fixture = await createGlobalPermitFixture();
  const admin = await PostgresTrustRegistryAdmin.connect({
    connectionString: trustAdminConnectionString,
    schema: fixture.schema,
    role: trustAdminRole
  });
  const monitor = fixture.admin;
  const key = `forge-trust:"${fixture.schema}"`;
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'pem'
  });
  const blocker = postgres(ownerConnectionString, { onnotice: () => undefined });
  let releaseWriter: (() => void) | undefined;
  let writerLocked: (() => void) | undefined;
  let releaseScope: (() => void) | undefined;
  let scopeLocked: (() => void) | undefined;
  const writerHeld = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const writerReady = new Promise<void>((resolve) => {
    writerLocked = resolve;
  });
  const scopeHeld = new Promise<void>((resolve) => {
    releaseScope = resolve;
  });
  const scopeReady = new Promise<void>((resolve) => {
    scopeLocked = resolve;
  });
  const permitRequest = {
    scopeId: fixture.scopeId,
    claimId: fixture.originalClaim.claimId,
    owner: fixture.originalClaim.owner,
    token: fixture.originalGrant.token,
    resource: fixture.originalClaim.resources[0] ?? { type: 'repository' as const }
  };
  try {
    const writerFirst = blocker.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
      writerLocked?.();
      await writerHeld;
    });
    await writerReady;
    const permitFirst = fixture.peer.beginFencedMutation(permitRequest);
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await monitor`select pg_blocking_pids(pid) as blockers from pg_stat_activity
        where application_name='forge-global-authority' and wait_event_type='Lock'
          and query like '%pg_advisory_xact_lock_shared%'`;
      if (rows.some((row) => Array.isArray(row.blockers) && row.blockers.length > 0)) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(blocked).toBe(true);
    releaseWriter?.();
    await writerFirst;
    const permitOne = await permitFirst;
    await fixture.peer.endFencedMutation(permitOne);
    expect(await admin.registerKey('first-key', publicKey)).toBe(1);

    const scopeBlocker = blocker.begin(async (tx) => {
      await tx.unsafe(
        `lock table "${fixture.schema}".forge_global_scopes in access exclusive mode`
      );
      scopeLocked?.();
      await scopeHeld;
    });
    await scopeReady;
    const permitSecond = fixture.peer.beginFencedMutation(permitRequest);
    const waitingPermit = await blockedBackend(
      monitor,
      fixture.schema,
      'forge-global-authority',
      'forge_global_scopes'
    );
    const writerSecond = admin.revokeKey('first-key', publicKey);
    let writerBlocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await monitor`select pg_blocking_pids(pid) as blockers from pg_stat_activity
        where application_name='forge-trust-admin' and wait_event_type='Lock'
          and query like '%forge_trust_write%'`;
      if (
        rows.some((row) => Array.isArray(row.blockers) && row.blockers.includes(waitingPermit.pid))
      ) {
        writerBlocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(writerBlocked).toBe(true);
    releaseScope?.();
    await scopeBlocker;
    const permitTwo = await permitSecond;
    expect(await writerSecond).toBe(2);
    await fixture.peer.endFencedMutation(permitTwo);
    expect(
      await monitor.unsafe(`select state from "${fixture.schema}".forge_global_trust_keys
      where key_id='first-key'`)
    ).toMatchObject([{ state: 'REVOKED' }]);
  } finally {
    releaseWriter?.();
    releaseScope?.();
    await Promise.all([admin.close(), blocker.end()]);
    await fixture.close();
  }
}, 20_000);

it('serializes generation issuance behind an already held scope lock', async () => {
  const fixture = await createGlobalPermitFixture();
  const issuer = await PostgresExecutionGenerationIssuer.connect({
    connectionString: generationIssuerConnectionString,
    schema: fixture.schema,
    role: generationIssuerRole
  });
  const blocker = postgres(ownerConnectionString, { onnotice: () => undefined });
  const setupDigest = 'a'.repeat(64);
  const executionDigest = 'b'.repeat(64);
  const binding = {
    generationId: 'generation-issue-race',
    scopeId: fixture.scopeId,
    parentClaimId: fixture.originalClaim.claimId,
    runId: fixture.originalClaim.owner.runId,
    taskId: fixture.originalClaim.owner.taskId,
    attemptId: fixture.originalClaim.owner.attemptId,
    workspaceId: 'workspace-1',
    supervisorId: 'supervisor-race',
    setupPlanDigest: setupDigest,
    executionPlanDigest: executionDigest
  };
  let releaseScope: (() => void) | undefined;
  let scopeLocked: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseScope = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    scopeLocked = resolve;
  });
  try {
    await fixture.admin.unsafe(
      `update "${fixture.schema}".forge_global_claims
      set owner_json=$3 where scope_id=$1 and claim_id=$2`,
      [
        binding.scopeId,
        binding.parentClaimId,
        JSON.stringify({
          ...fixture.originalClaim.owner,
          workspaceId: binding.workspaceId
        })
      ]
    );
    await fixture.admin.unsafe(
      `insert into "${fixture.schema}".forge_global_workspace_phases
      (scope_id,parent_claim_id,phase,workspace_id,setup_plan_digest,execution_plan_digest)
      values ($1,$2,'INITIAL_ADMITTED',$3,$4,$5)`,
      [binding.scopeId, binding.parentClaimId, binding.workspaceId, setupDigest, executionDigest]
    );
    const first = blocker.begin(async (tx) => {
      await tx.unsafe(
        `select id from "${fixture.schema}".forge_global_scopes
        where id=$1 for update`,
        [fixture.scopeId]
      );
      scopeLocked?.();
      await held;
    });
    await ready;
    const issuing = issuer.issue(binding);
    const waitingIssuer = await blockedBackend(
      fixture.admin,
      fixture.schema,
      'forge-generation-issuer',
      'forge_global_scopes'
    );
    expect(waitingIssuer.blockers.length).toBeGreaterThan(0);
    releaseScope?.();
    await first;
    await issuing;
    expect(
      await fixture.admin.unsafe(
        `select state from "${fixture.schema}".forge_global_generations
      where id=$1`,
        [binding.generationId]
      )
    ).toMatchObject([{ state: 'ISSUED' }]);
    await issuer.revoke(binding.generationId, binding.scopeId);
    expect(
      await fixture.admin.unsafe(
        `select state from "${fixture.schema}".forge_global_generations
      where id=$1`,
        [binding.generationId]
      )
    ).toMatchObject([{ state: 'REVOKED' }]);
  } finally {
    releaseScope?.();
    await Promise.all([issuer.close(), blocker.end()]);
    await fixture.close();
  }
}, 20_000);

it('gates ordinary PostgreSQL mutation, replay, release and reclaim for a marked setup parent', async () => {
  const fixture = await createGlobalPermitFixture();
  try {
    const request = {
      scopeId: fixture.scopeId,
      claimId: fixture.originalClaim.claimId,
      owner: fixture.originalClaim.owner,
      token: fixture.originalGrant.token,
      resource: fixture.originalClaim.resources[0]
    };
    for (const phase of ['INITIAL_ADMITTED', 'WORKSPACE_ARMED', 'WORKSPACE_UNCERTAIN']) {
      await fixture.admin.unsafe(
        `insert into "${fixture.schema}".forge_global_workspace_phases
         (scope_id,parent_claim_id,phase) values ($1,$2,$3)
         on conflict (scope_id,parent_claim_id) do update set phase=excluded.phase`,
        [fixture.scopeId, fixture.originalClaim.claimId, phase]
      );
      await expect(fixture.peer.assertCurrentMutationToken(request)).rejects.toThrow(
        'Workspace setup parent forbids ordinary mutation authority'
      );
      await expect(fixture.peer.beginFencedMutation(request)).rejects.toThrow(
        'Workspace setup parent forbids ordinary mutation authority'
      );
      await expect(fixture.peer.claimGlobalMutation(fixture.originalClaim)).rejects.toThrow(
        'Workspace setup parent forbids ordinary mutation authority'
      );
      await expect(
        fixture.peer.releaseGlobalMutation({
          ...request,
          expectedVersion: 1,
          stopEvidence: 'No writes remain'
        })
      ).rejects.toThrow('Workspace setup parent forbids ordinary mutation authority');
    }
    await fixture.authority.markMutationUncertain({
      ...request,
      evidence: 'Workspace result is uncertain'
    });
    await expect(
      fixture.peer.reclaimUncertainMutation({
        ...request,
        expectedVersion: 2,
        verifiedQuiescenceEvidence: 'Stopped externally'
      })
    ).rejects.toThrow('Workspace setup parent forbids ordinary mutation authority');
    expect(await fixture.peer.recoverFencedMutationPermits(fixture.scopeId)).toEqual([]);
    expect((await fixture.peer.recoverRepositoryMutationAuthority(fixture.scopeId))[0]?.state).toBe(
      'HELD_UNCERTAIN'
    );
  } finally {
    await fixture.close();
  }
});

it('refuses a legacy PostgreSQL worker at GLOBAL_READY even on an already connected store', async () => {
  const fixture = await createGlobalPermitFixture();
  try {
    await expect(fixture.store.assertLegacyWorkerCompositionAllowed()).rejects.toThrow(
      'Legacy worker composition is closed by global cutover'
    );
  } finally {
    await fixture.close();
  }
});

it('refuses a legacy PostgreSQL worker when the cutover starts after store connection', async () => {
  const schema = `forge_worker_cutover_${++fixtureOrdinal}`;
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString);
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  try {
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema, role },
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    await store.assertLegacyWorkerCompositionAllowed();
    await authority.beginLegacyCutover();
    await expect(store.assertLegacyWorkerCompositionAllowed()).rejects.toThrow(
      'Legacy worker composition is closed by global cutover'
    );
  } finally {
    await Promise.all([store?.close(), authority?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

const createGlobalCutoverFixture = async (): Promise<GlobalMutationCutoverFixture> => {
  const schema = `forge_global_race_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  let peer: PostgresGlobalMutationAuthority | undefined;
  let blocker: ReturnType<typeof postgres> | undefined;
  let unblock: (() => void) | undefined;
  let blocking: Promise<void> | undefined;
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    peer = await PostgresGlobalMutationAuthority.connect(runtime);
    const scopeId = await authority.registerScope('registered-A');
    const runId = `historical-${fixtureOrdinal}`;
    const original = durableAuthorityRunRequest(runId);
    const request = { ...original, run: { ...original.run, repositoryId: 'unregistered-B' } };
    await store.createRun(request);
    const plan = request.taskBindings[0]?.leasePlan;
    if (plan === undefined) {
      throw new Error('Missing historical binding');
    }
    await store.persistAttempt({
      runId,
      attempt: {
        id: 'builder-attempt',
        runId,
        taskId: 'task-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: taskLeasePlanFingerprint(plan),
        state: 'PREPARING',
        revision: 1
      }
    });
    const repair = {
      ...durableAuthorityRepairAttempt('repair-attempt'),
      runId,
      parentReviewSubject: {
        ...durableAuthorityRepairAttempt('repair-attempt').parentReviewSubject,
        builderAttemptId: 'builder-attempt'
      }
    };
    await store.persistRepairAttempt({ runId, attempt: repair });
    const timestamp = new Date('2026-09-29T00:00:00.000Z');
    const lease = {
      id: 'admitted-lease',
      runId,
      agentId: 'agent-1',
      taskId: 'task-1',
      resource: { type: 'project' as const, projectId: 'project-1' },
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: timestamp,
      lastHeartbeatAt: timestamp
    };
    const savedStore = store;
    const savedAuthority = authority;
    const savedPeer = peer;
    const admitted = async (kind: 'builder' | 'repair' | 'integration' | 'dynamic-lease') => {
      if (kind === 'builder') {
        await savedStore.claimBuilderStart({
          runId,
          attempt: {
            id: 'builder-attempt',
            runId,
            taskId: 'task-1',
            agentId: 'agent-1',
            workspaceId: 'workspace-1',
            leasePlanFingerprint: taskLeasePlanFingerprint(plan),
            state: 'STARTING',
            revision: 2,
            startedAt: timestamp
          },
          leases: [lease]
        });
        return { ownerKey: `builder:${runId}:builder-attempt` };
      }
      if (kind === 'repair') {
        await savedStore.claimRepairStart({
          runId,
          attempt: {
            ...repair,
            state: 'STARTING',
            revision: 2,
            startedAt: timestamp
          }
        });
        return { ownerKey: `repair:${runId}:repair-attempt` };
      }
      if (kind === 'integration') {
        await savedStore.claimIntegrationStart({
          runId,
          taskId: 'task-1',
          workspaceId: 'workspace-1',
          outputAttemptId: 'builder-attempt'
        });
        return { ownerKey: `integration:${runId}:task-1` };
      }
      await savedStore.persistLease({ runId, lease });
      return { ownerKey: `lease:${runId}:admitted-lease` };
    };
    const waiting = async (
      application: 'forge-authority' | 'forge-global-authority',
      target: 'gate' | 'admission' | 'inventory' = 'gate'
    ) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await admin`select 1 from pg_stat_activity where datname=current_database()
          and application_name=${application} and wait_event_type='Lock'
          and query like ${`%"${schema}".${target === 'gate' ? 'forge_global_control' : target === 'admission' ? 'forge_runs' : 'forge_global_legacy_owners'}%`} limit 1`;
        if (rows.length) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`${application} did not wait on the deployment gate`);
    };
    const holdContention = async (target: 'admission' | 'inventory') => {
      blocker = postgres(runtimeConnectionString, { onnotice: () => undefined });
      let signal: (() => void) | undefined;
      const acquired = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      blocking = blocker
        .begin(async (tx) => {
          if (target === 'admission') {
            await tx.unsafe(`select id from "${schema}".forge_runs where id=$1 for update`, [
              runId
            ]);
          } else {
            await tx.unsafe(
              `lock table "${schema}".forge_global_legacy_owners in access exclusive mode`
            );
          }
          signal?.();
          await release;
        })
        .then(() => undefined);
      await acquired;
      return () => unblock?.();
    };
    const evidence = async () => {
      const rows = await admin.unsafe(
        `select kind,key,payload from "${schema}".forge_records
        where run_id=$1 and kind in ('builder','repair','lease','integration-claim') order by kind,key`,
        [runId]
      );
      return {
        attempts: rows
          .filter((row) => row.kind === 'builder' || row.kind === 'repair')
          .map((row) => `${row.kind}:${row.key}:${row.payload}`),
        leases: rows
          .filter((row) => row.kind === 'lease')
          .map((row) => `${row.key}:${row.payload}`),
        integrationClaims: rows
          .filter((row) => row.kind === 'integration-claim')
          .map((row) => `${row.key}:${row.payload}`)
      };
    };
    return {
      authority: savedAuthority,
      peer: savedPeer,
      scopeId,
      registeredRepositoryId: 'registered-A',
      unregisteredRepositoryId: 'unregistered-B',
      historicalRunId: runId,
      holdLegacyAdmissionAtGate: async (kind) => {
        const release = await holdContention('admission');
        const finished = admitted(kind);
        await waiting('forge-authority', 'admission');
        const gate =
          await admin.unsafe(`select 1 from pg_locks l join pg_class c on c.oid=l.relation
          where c.oid='"${schema}".forge_global_control'::regclass and l.mode='RowShareLock' and l.granted
          and l.pid in (select pid from pg_stat_activity where application_name='forge-authority' and wait_event_type='Lock')`);
        expect(gate).toHaveLength(1);
        return { finished, release };
      },
      holdCutoverAtGate: async () => {
        const release = await holdContention('inventory');
        const finished = savedAuthority.beginLegacyCutover();
        await waiting('forge-global-authority', 'inventory');
        const gate =
          await admin.unsafe(`select 1 from pg_locks l join pg_class c on c.oid=l.relation
          where c.oid='"${schema}".forge_global_control'::regclass and l.mode='RowShareLock' and l.granted
          and l.pid in (select pid from pg_stat_activity where application_name='forge-global-authority' and wait_event_type='Lock')`);
        expect(gate).toHaveLength(1);
        return { finished, release };
      },
      admitLegacyWriter: async (kind) => {
        await admitted(kind);
      },
      assertWaitingOnGate: async (operation) => {
        await waiting(operation === 'cutover' ? 'forge-global-authority' : 'forge-authority');
      },
      readLegacyWriterEvidence: evidence,
      assertRejectedAdmissionHasNoStartResidue: async (kind) => {
        const rows = await evidence();
        if (kind === 'builder') {
          expect(rows.attempts.find((value) => value.startsWith('builder:'))).toContain(
            '"state":"PREPARING"'
          );
          expect(rows.leases).toEqual([]);
        }
        if (kind === 'repair') {
          expect(rows.attempts.find((value) => value.startsWith('repair:'))).toContain(
            '"state":"PREPARING"'
          );
          const history = await admin.unsafe(
            `select 1 from "${schema}".forge_records where run_id=$1 and kind='repair-history'`,
            [runId]
          );
          expect(history).toHaveLength(0);
        }
      },
      close: async () => {
        unblock?.();
        await blocking?.catch(() => undefined);
        await blocker?.end();
        await Promise.all([savedAuthority.close(), savedPeer.close(), savedStore.close()]);
        await admin.unsafe(`drop schema "${schema}" cascade`);
        await admin.end();
      }
    };
  } catch (error) {
    unblock?.();
    await blocking?.catch(() => undefined);
    await Promise.all([blocker?.end(), authority?.close(), peer?.close(), store?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
    throw error;
  }
};

globalMutationCutoverContract('PostgreSQL isolated server', createGlobalCutoverFixture);

const holdRow = async (schema: string, table: 'forge_runs' | 'forge_global_claims', id: string) => {
  const sql = postgres(runtimeConnectionString, { onnotice: () => undefined });
  let acquired: ((pid: number) => void) | undefined;
  let unblock: (() => void) | undefined;
  const ready = new Promise<number>((resolve) => {
    acquired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const finished = sql.begin(async (tx) => {
    const rows = await tx.unsafe(
      table === 'forge_runs'
        ? `select pg_backend_pid() as pid from "${schema}".forge_runs where id=$1 for update`
        : `select pg_backend_pid() as pid from "${schema}".forge_global_claims where claim_id=$1 for update`,
      [id]
    );
    if (rows.length !== 1) {
      throw new Error('Missing controlled overlap row');
    }
    acquired?.(Number(rows[0]?.pid));
    await released;
  });
  try {
    const pid = await ready;
    return {
      pid,
      release: () => unblock?.(),
      close: async () => {
        unblock?.();
        await finished;
        await sql.end();
      }
    };
  } catch (error) {
    unblock?.();
    await finished.catch(() => undefined);
    await sql.end();
    throw error;
  }
};

const blockedBackend = async (
  admin: ReturnType<typeof postgres>,
  schema: string,
  application:
    | 'forge-authority'
    | 'forge-global-authority'
    | 'forge-generation-issuer'
    | 'forge-setup-admission'
    | 'forge-trust-admin',
  table:
    | 'forge_runs'
    | 'forge_global_scopes'
    | 'forge_global_claims'
    | 'forge_global_trust_registry'
): Promise<{ pid: number; blockers: number[] }> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await admin`select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname=current_database() and application_name=${application}
      and wait_event_type='Lock' and (
        query like ${`%"${schema}".${table}%`} or
          (${application}='forge-generation-issuer' and query like '%forge_generation_write%') or
          (${application}='forge-setup-admission' and
            (query like '%forge_setup_admit%' or query like '%forge_workspace_permit_begin%')) or
         (${application}='forge-trust-admin' and query like '%forge_trust_write%'))`;
    const row = rows[0];
    if (row !== undefined) {
      const blockers: unknown = row.blockers;
      if (!Array.isArray(blockers) || !blockers.every((pid) => typeof pid === 'number')) {
        throw new Error('Unexpected PostgreSQL blocking PID evidence');
      }
      return { pid: Number(row.pid), blockers: blockers.map(Number) };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${application} did not block on ${table}`);
};

const createScopeOverlapFixture = async () => {
  const fixture = await createGlobalPermitFixture();
  const { authority, peer, store, scopeId, originalClaim, originalGrant, schema } = fixture;
  const third = await PostgresGlobalMutationAuthority.connect({
    connectionString: runtimeConnectionString,
    schema,
    role: runtimeRole
  });
  try {
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original claim');
    }
    await peer.releaseGlobalMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version,
      stopEvidence: 'Original writer stopped before overlap.'
    });
    const otherRunId = `competing-${fixtureOrdinal}`;
    await authority.registerAlias(scopeId, 'overlap-alias');
    const request = durableAuthorityRunRequest(otherRunId);
    await store.createRun({ ...request, run: { ...request.run, repositoryId: 'overlap-alias' } });
    await third.bindRun(otherRunId, 'overlap-alias');
    const binding = request.taskBindings[0];
    if (binding === undefined) {
      throw new Error('Missing competing binding');
    }
    await store.persistAttempt({
      runId: otherRunId,
      attempt: {
        id: 'other-builder',
        runId: otherRunId,
        taskId: 'task-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
        state: 'PREPARING',
        revision: 1
      }
    });
    const competing: GlobalMutationClaim = {
      scopeId,
      claimId: 'competing-claim',
      owner: {
        runId: otherRunId,
        taskId: 'task-1',
        attemptId: 'other-builder',
        agentId: 'agent-1'
      },
      resources: [{ type: 'project', projectId: 'project-1' }]
    };
    return {
      ...fixture,
      third,
      competing,
      close: async () => {
        await third.close();
        await fixture.close();
      }
    };
  } catch (error) {
    await third.close();
    await fixture.close();
    throw error;
  }
};

it('uses the actual scope row to serialize competing cross-run claims and persists only the winner', async () => {
  const fixture = await createScopeOverlapFixture();
  const { admin, schema, replacementClaim, competing, authority, peer, third } = fixture;
  const blocker = await holdRow(schema, 'forge_runs', replacementClaim.owner.runId);
  let first: Promise<Awaited<ReturnType<typeof authority.claimGlobalMutation>>> | undefined;
  let second: Promise<Awaited<ReturnType<typeof authority.claimGlobalMutation>>> | undefined;
  try {
    first = authority.claimGlobalMutation(replacementClaim);
    const a = await blockedBackend(admin, schema, 'forge-global-authority', 'forge_runs');
    expect(a.blockers).toContain(blocker.pid);
    second = peer.claimGlobalMutation(competing);
    const b = await blockedBackend(admin, schema, 'forge-global-authority', 'forge_global_scopes');
    expect(b.blockers).toContain(a.pid);
    blocker.release();
    expect(await first).toMatchObject({ status: 'granted' });
    expect(await second).toMatchObject({ status: 'blocked' });
    const rows = await admin.unsafe(
      `select claim_id,state from "${schema}".forge_global_claims where claim_id in ($1,$2) order by claim_id`,
      [replacementClaim.claimId, competing.claimId]
    );
    expect(rows).toMatchObject([{ claim_id: replacementClaim.claimId, state: 'ACTIVE' }]);
    expect(await third.recoverRepositoryMutationAuthority(fixture.scopeId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ claimId: replacementClaim.claimId })])
    );
    expect(
      await admin.unsafe(
        `select payload from "${schema}".forge_records where run_id=$1 and kind='builder' and key=$2`,
        [competing.owner.runId, competing.owner.attemptId]
      )
    ).toEqual([
      expect.objectContaining({ payload: expect.stringContaining('"state":"PREPARING"') })
    ]);
  } finally {
    blocker.release();
    await Promise.allSettled([first, second]);
    await blocker.close();
    await fixture.close();
  }
});

it('grants another scope while a claim holds the first scope row', async () => {
  const fixture = await createScopeOverlapFixture();
  const { admin, schema, authority, peer, third, store, replacementClaim, scopeId } = fixture;
  let blocker: Awaited<ReturnType<typeof holdRow>> | undefined;
  let held: Promise<Awaited<ReturnType<typeof authority.claimGlobalMutation>>> | undefined;
  try {
    const otherScopeId = await authority.registerScope('independent-repository');
    await authority.activateScope(otherScopeId);
    const runId = `independent-${fixtureOrdinal}`;
    const request = durableAuthorityRunRequest(runId);
    await store.createRun({
      ...request,
      run: { ...request.run, repositoryId: 'independent-repository' }
    });
    await peer.bindRun(runId, 'independent-repository');
    const binding = request.taskBindings[0];
    if (binding === undefined) {
      throw new Error('Missing independent scope binding');
    }
    await store.persistAttempt({
      runId,
      attempt: {
        id: 'independent-builder',
        runId,
        taskId: 'task-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
        state: 'PREPARING',
        revision: 1
      }
    });
    blocker = await holdRow(schema, 'forge_runs', replacementClaim.owner.runId);
    held = authority.claimGlobalMutation(replacementClaim);
    const a = await blockedBackend(admin, schema, 'forge-global-authority', 'forge_runs');
    expect(a.blockers).toContain(blocker.pid);
    const granted = await third.claimGlobalMutation({
      scopeId: otherScopeId,
      claimId: 'independent-claim',
      owner: { runId, taskId: 'task-1', attemptId: 'independent-builder', agentId: 'agent-1' },
      resources: [{ type: 'project', projectId: 'project-1' }]
    });
    expect(granted).toMatchObject({ status: 'granted', token: 1 });
    expect(
      await admin.unsafe(
        `select id,next_token from "${schema}".forge_global_scopes
      where id in ($1,$2) order by id`,
        [scopeId, otherScopeId]
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: scopeId, next_token: '1' }),
        expect.objectContaining({ id: otherScopeId, next_token: '1' })
      ])
    );
    expect((await blockedBackend(admin, schema, 'forge-global-authority', 'forge_runs')).pid).toBe(
      a.pid
    );
    blocker.release();
    expect(await held).toMatchObject({ status: 'granted', token: 2 });
  } finally {
    blocker?.release();
    await Promise.allSettled([held]);
    await blocker?.close();
    await fixture.close();
  }
});

it.each([
  ['request cancellation', 'CANCEL_REQUESTED'],
  ['finish failed', 'FAILED'],
  ['finish completed', 'COMPLETED']
] as const)(
  'serializes global claim and %s in both commit orders through the scope lock',
  async (operation, finalState) => {
    for (const claimFirst of [true, false]) {
      const fixture = await createScopeOverlapFixture();
      const { admin, schema, replacementClaim, authority, peer, third, store } = fixture;
      const runId = replacementClaim.owner.runId;
      const blocker = await holdRow(schema, 'forge_runs', runId);
      const lifecycle = async () =>
        operation === 'request cancellation'
          ? store.requestCancellation(runId)
          : store.updateRunState(runId, finalState);
      let first: Promise<unknown> | undefined;
      let second: Promise<unknown> | undefined;
      try {
        first = claimFirst ? authority.claimGlobalMutation(replacementClaim) : lifecycle();
        const holder = await blockedBackend(
          admin,
          schema,
          claimFirst ? 'forge-global-authority' : 'forge-authority',
          'forge_runs'
        );
        expect(holder.blockers).toContain(blocker.pid);
        second = claimFirst ? lifecycle() : peer.claimGlobalMutation(replacementClaim);
        const waiter = await blockedBackend(
          admin,
          schema,
          claimFirst ? 'forge-authority' : 'forge-global-authority',
          'forge_global_scopes'
        );
        expect(waiter.blockers).toContain(holder.pid);
        blocker.release();
        if (claimFirst) {
          expect(await first).toMatchObject({ status: 'granted' });
          await second;
        } else {
          await first;
          await expect(second).rejects.toThrow();
        }
        expect(
          (await third.recoverRepositoryMutationAuthority(fixture.scopeId)).filter(
            (lease) => lease.claimId === replacementClaim.claimId
          )
        ).toHaveLength(claimFirst ? 1 : 0);
        expect(
          await admin.unsafe(`select state from "${schema}".forge_runs where id=$1`, [runId])
        ).toMatchObject([{ state: finalState }]);
        const attempts = await admin.unsafe(
          `select payload from "${schema}".forge_records where run_id=$1 and kind='builder' and key='replacement'`,
          [runId]
        );
        expect(JSON.parse(String(attempts[0]?.payload))).toMatchObject({
          state: claimFirst ? 'STARTING' : 'PREPARING'
        });
        if (finalState === 'CANCEL_REQUESTED') {
          expect(await store.finalizeCancellation(runId)).toMatchObject({ state: 'CANCELLED' });
          expect(
            await admin.unsafe(`select state from "${schema}".forge_runs where id=$1`, [runId])
          ).toMatchObject([{ state: 'CANCELLED' }]);
        }
      } finally {
        blocker.release();
        await Promise.allSettled([first, second]);
        await blocker.close();
        await fixture.close();
      }
    }
  }
);

it.each(['release', 'reclaim'] as const)(
  'serializes %s against a stale fenced write at the scope row before callback execution',
  async (operation) => {
    const fixture = await createGlobalPermitFixture();
    const { admin, schema, authority, peer, originalClaim, originalGrant, scopeId } = fixture;
    const third = await PostgresGlobalMutationAuthority.connect({
      connectionString: runtimeConnectionString,
      schema,
      role: runtimeRole
    });
    let blocker: Awaited<ReturnType<typeof holdRow>> | undefined;
    let transition: Promise<void> | undefined;
    let attempted: Promise<unknown> | undefined;
    try {
      if (operation === 'reclaim') {
        await authority.markMutationUncertain({
          scopeId,
          claimId: originalClaim.claimId,
          owner: originalClaim.owner,
          token: originalGrant.token,
          evidence: 'The worker outcome is uncertain.'
        });
      }
      const lease = (await third.recoverRepositoryMutationAuthority(scopeId))[0];
      if (lease === undefined) {
        throw new Error('Missing claim for transition overlap');
      }
      blocker = await holdRow(schema, 'forge_global_claims', originalClaim.claimId);
      transition =
        operation === 'release'
          ? authority.releaseGlobalMutation({
              scopeId,
              claimId: originalClaim.claimId,
              owner: originalClaim.owner,
              token: originalGrant.token,
              expectedVersion: lease.version,
              stopEvidence: 'Original writer is stopped.'
            })
          : authority.reclaimUncertainMutation({
              scopeId,
              claimId: originalClaim.claimId,
              owner: originalClaim.owner,
              token: originalGrant.token,
              expectedVersion: lease.version,
              verifiedQuiescenceEvidence: 'The old worker is verified quiescent.'
            });
      const holder = await blockedBackend(
        admin,
        schema,
        'forge-global-authority',
        'forge_global_claims'
      );
      expect(holder.blockers).toContain(blocker.pid);
      const callback = vi.fn(async () => 'unsafe stale write');
      attempted = new FencedMutationPort(peer).execute(
        {
          scopeId,
          claimId: originalClaim.claimId,
          owner: originalClaim.owner,
          token: originalGrant.token,
          resource: { type: 'project', projectId: 'project-1' }
        },
        callback
      );
      const waiter = await blockedBackend(
        admin,
        schema,
        'forge-global-authority',
        'forge_global_scopes'
      );
      expect(waiter.blockers).toContain(holder.pid);
      blocker.release();
      await transition;
      await expect(attempted).rejects.toThrow();
      expect(callback).not.toHaveBeenCalled();
      expect((await third.recoverRepositoryMutationAuthority(scopeId))[0]).toMatchObject({
        state: 'RELEASED'
      });
      expect(await third.recoverFencedMutationPermits(scopeId)).toEqual([]);
      expect(
        await admin.unsafe(
          `select state,version from "${schema}".forge_global_claims where claim_id=$1`,
          [originalClaim.claimId]
        )
      ).toMatchObject([{ state: 'RELEASED', version: operation === 'release' ? '2' : '3' }]);
    } finally {
      blocker?.release();
      await Promise.allSettled([transition, attempted]);
      await blocker?.close();
      await third.close();
      await fixture.close();
    }
  }
);

it('fences competing runs in the same scope across a third PostgreSQL connection', async () => {
  const fixture = await createGlobalPermitFixture();
  const { authority, peer, store, originalClaim, originalGrant, scopeId, schema, admin } = fixture;
  const third = await PostgresGlobalMutationAuthority.connect({
    connectionString: runtimeConnectionString,
    schema,
    role: runtimeRole
  });
  try {
    await authority.registerAlias(scopeId, 'second-alias');
    const runId = 'second-run';
    const request = durableAuthorityRunRequest(runId);
    await store.createRun({ ...request, run: { ...request.run, repositoryId: 'second-alias' } });
    await third.bindRun(runId, 'second-alias');
    const binding = request.taskBindings[0];
    if (binding === undefined) {
      throw new Error('Missing competing run binding');
    }
    await store.persistAttempt({
      runId,
      attempt: {
        id: 'second-builder',
        runId,
        taskId: 'task-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
        state: 'PREPARING',
        revision: 1
      }
    });
    const competing: GlobalMutationClaim = {
      scopeId,
      claimId: 'second-claim',
      owner: { runId, taskId: 'task-1', attemptId: 'second-builder', agentId: 'agent-1' },
      resources: [{ type: 'project', projectId: 'project-1' }]
    };
    expect(await third.claimGlobalMutation(competing)).toMatchObject({
      status: 'blocked',
      blockers: [
        expect.objectContaining({ claimId: originalClaim.claimId, token: originalGrant.token })
      ]
    });
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original lease');
    }
    await peer.markMutationUncertain({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      evidence: 'Worker outcome is uncertain.'
    });
    expect(await third.claimGlobalMutation(competing)).toMatchObject({
      status: 'blocked',
      blockers: [expect.objectContaining({ state: 'HELD_UNCERTAIN' })]
    });
    await authority.reclaimUncertainMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version + 1,
      verifiedQuiescenceEvidence: 'The old worker has stopped.'
    });
    const granted = await third.claimGlobalMutation(competing);
    expect(granted).toMatchObject({ status: 'granted' });
    if (granted.status !== 'granted') {
      throw new Error('Competing claim was not granted');
    }
    expect(granted.token).toBeGreaterThan(originalGrant.token);
    const rows = await admin.unsafe(
      `select claim_id,token,state from "${schema}".forge_global_claims order by claim_id`
    );
    expect(rows).toMatchObject([
      { claim_id: originalClaim.claimId, state: 'RELEASED' },
      { claim_id: competing.claimId, state: 'ACTIVE' }
    ]);
    expect(await peer.recoverRepositoryMutationAuthority(scopeId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ claimId: competing.claimId, token: granted.token })
      ])
    );
  } finally {
    await third.close();
    await fixture.close();
  }
});

it('rejects invented, mismatched, or overbroad global admissions without consuming a token', async () => {
  const fixture = await createGlobalPermitFixture();
  try {
    const { peer, originalClaim, replacementClaim, schema, admin, scopeId, originalGrant } =
      fixture;
    const before = await admin.unsafe(
      `select next_token from "${schema}".forge_global_scopes where id=$1`,
      [scopeId]
    );
    for (const [claimId, owner] of [
      ['unknown-attempt', { ...replacementClaim.owner, attemptId: 'absent' }],
      ['wrong-task', { ...replacementClaim.owner, taskId: 'absent' }],
      ['wrong-agent', { ...replacementClaim.owner, agentId: 'absent' }],
      ['already-started', originalClaim.owner]
    ] as const) {
      await expect(
        peer.claimGlobalMutation({ ...replacementClaim, claimId, owner })
      ).rejects.toThrow();
    }
    for (const resources of [
      [{ type: 'repository' as const }],
      [{ type: 'project' as const, projectId: 'different-project' }]
    ]) {
      await expect(peer.claimGlobalMutation({ ...replacementClaim, resources })).rejects.toThrow(
        'exceeds the approved lease plan'
      );
    }
    expect(
      await admin.unsafe(`select next_token from "${schema}".forge_global_scopes where id=$1`, [
        scopeId
      ])
    ).toEqual(before);
    expect(
      await admin.unsafe(`select claim_id from "${schema}".forge_global_claims`)
    ).toMatchObject([{ claim_id: originalClaim.claimId }]);
    expect(await peer.claimGlobalMutation(originalClaim)).toMatchObject({
      status: 'granted',
      token: originalGrant.token
    });
    expect(await peer.claimGlobalMutation(replacementClaim)).toMatchObject({ status: 'blocked' });
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original claim');
    }
    await peer.releaseGlobalMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version,
      stopEvidence: 'Worker stopped.'
    });
    const replacement = await peer.claimGlobalMutation(replacementClaim);
    expect(replacement).toMatchObject({ status: 'granted' });
    if (replacement.status !== 'granted') {
      throw new Error('Missing replacement claim');
    }
    expect(replacement.token).toBeGreaterThan(originalGrant.token);
    const row = await admin.unsafe(
      `select payload from "${schema}".forge_records where run_id=$1 and kind='builder' and key='replacement'`,
      [originalClaim.owner.runId]
    );
    expect(JSON.parse(String(row[0]?.payload))).toMatchObject({ state: 'STARTING', revision: 2 });
  } finally {
    await fixture.close();
  }
});

it('advances an admitted repair attempt and its history in the same claim transaction', async () => {
  const fixture = await createGlobalPermitFixture();
  try {
    const { store, peer, admin, schema, scopeId, originalClaim, originalGrant } = fixture;
    const runId = originalClaim.owner.runId;
    const repair = {
      ...durableAuthorityRepairAttempt('repair-attempt'),
      runId,
      parentReviewSubject: {
        ...durableAuthorityRepairAttempt('repair-attempt').parentReviewSubject,
        builderAttemptId: 'original'
      }
    };
    await store.persistRepairAttempt({ runId, attempt: repair });
    const claim: GlobalMutationClaim = {
      scopeId,
      claimId: 'repair-claim',
      owner: { runId, taskId: 'task-1', attemptId: repair.id, agentId: repair.agentId },
      resources: [{ type: 'project', projectId: 'project-1' }]
    };
    await expect(peer.claimGlobalMutation(claim)).rejects.toThrow('no admitted work item');
    const binding = await store.recoverTaskBinding(runId, 'task-1');
    if (binding === undefined) {
      throw new Error('Missing repair binding');
    }
    await store.persistRepairWorkItem({
      ...durableAuthorityRepairWorkItem({ ...repair, runId }),
      builderAttemptId: 'original',
      leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan)
    });
    expect(await peer.claimGlobalMutation(claim)).toMatchObject({ status: 'blocked' });
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original lease');
    }
    await peer.releaseGlobalMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version,
      stopEvidence: 'Worker stopped.'
    });
    expect(await peer.claimGlobalMutation(claim)).toMatchObject({ status: 'granted' });
    const rows = await admin.unsafe(
      `select kind,payload from "${schema}".forge_records where run_id=$1 and kind in ('repair','repair-history') order by kind`,
      [runId]
    );
    expect(rows.map((row) => [row.kind, JSON.parse(String(row.payload)).state])).toEqual([
      ['repair', 'STARTING'],
      ['repair-history', 'PREPARING']
    ]);
  } finally {
    await fixture.close();
  }
});

it('keeps unknown-alias historical owners blocking every scope until classified and imported', async () => {
  const schema = `forge_global_import_${++fixtureOrdinal}`;
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  let peer: PostgresGlobalMutationAuthority | undefined;
  try {
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema, role },
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    peer = await PostgresGlobalMutationAuthority.connect(runtime);
    const scopeId = await authority.registerScope('known-repository');
    await store.createRun({
      ...durableAuthorityRunRequest('historical-run'),
      run: {
        ...durableAuthorityRunRequest('historical-run').run,
        repositoryId: 'unregistered-repository'
      }
    });
    await authority.beginLegacyCutover();
    expect(await peer.recoverLegacyOwners()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'run:historical-run',
          repositoryId: 'unregistered-repository',
          kind: 'run'
        })
      ])
    );
    await expect(peer.completeLegacyCutover('Workers stopped.')).rejects.toThrow('unresolved');
    await expect(peer.activateScope(scopeId)).rejects.toThrow('not globally ready');
    await peer.importLegacyOwner('run:historical-run', scopeId, {
      type: 'file',
      projectId: 'guess',
      fileId: 'guess'
    });
    await peer.completeLegacyCutover('All previous worker processes are stopped.');
    await peer.activateScope(scopeId);
    expect(await authority.registerScope('unregistered-repository')).toBe(scopeId);
    const third = await PostgresGlobalMutationAuthority.connect(runtime);
    try {
      expect(await third.recoverRepositoryMutationAuthority(scopeId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            claimId: 'legacy:run:historical-run',
            state: 'HELD_UNCERTAIN',
            resource: { type: 'repository' }
          })
        ])
      );
    } finally {
      await third.close();
    }
    const audit = await admin.unsafe(`select action,evidence from "${schema}".forge_global_audit`);
    expect(audit).toMatchObject([
      { action: 'complete-legacy-cutover', evidence: 'All previous worker processes are stopped.' }
    ]);
  } finally {
    await Promise.all([store?.close(), authority?.close(), peer?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

it('fails closed before allocating an unsafe BIGINT token', async () => {
  const fixture = await createGlobalPermitFixture();
  try {
    const { admin, schema, peer, originalClaim, originalGrant, replacementClaim, scopeId } =
      fixture;
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original lease');
    }
    await peer.releaseGlobalMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version,
      stopEvidence: 'Worker stopped.'
    });
    await admin.unsafe(`update "${schema}".forge_global_scopes set next_token=$2 where id=$1`, [
      scopeId,
      String(Number.MAX_SAFE_INTEGER)
    ]);
    await expect(peer.claimGlobalMutation(replacementClaim)).rejects.toThrow('token exhausted');
    const rows = await admin.unsafe(
      `select payload from "${schema}".forge_records where run_id=$1 and kind='builder' and key='replacement'`,
      [originalClaim.owner.runId]
    );
    expect(JSON.parse(String(rows[0]?.payload))).toMatchObject({ state: 'PREPARING', revision: 1 });
    expect(
      await admin.unsafe(
        `select claim_id from "${schema}".forge_global_claims where claim_id='replacement-claim'`
      )
    ).toEqual([]);
  } finally {
    await fixture.close();
  }
});

it('atomically creates a v4 run with its pre-registered scope and rejects missing aliases or cutover', async () => {
  const schema = `forge_launch_binding_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    expect(store.requiresGlobalRunBinding()).toBe(true);
    const missing = durableAuthorityRunRequest('missing-alias');
    await expect(store.createBoundRun(missing)).rejects.toThrow('Unregistered repository alias');
    expect(await store.recoverRun(missing.run.id)).toBeUndefined();
    const scopeId = await authority.registerScope(missing.run.repositoryId);
    const unbound = durableAuthorityRunRequest('unbound-legacy-run');
    await store.createRun(unbound);
    await expect(
      store.assertGlobalRunBinding(unbound.run.id, unbound.run.repositoryId)
    ).rejects.toThrow('matching immutable repository scope binding');
    await store.createBoundRun(missing);
    await store.assertGlobalRunBinding(missing.run.id, missing.run.repositoryId);
    const bindings = await admin.unsafe(
      `select run_id,repository_id,scope_id from "${schema}".forge_global_run_bindings where run_id=$1`,
      [missing.run.id]
    );
    expect(bindings).toMatchObject([
      { run_id: missing.run.id, repository_id: missing.run.repositoryId, scope_id: scopeId }
    ]);
    await expect(
      store.assertGlobalRunBinding(missing.run.id, 'different-repository')
    ).rejects.toThrow('matching immutable repository scope binding');
    await authority.beginLegacyCutover();
    await expect(store.createBoundRun(durableAuthorityRunRequest('after-barrier'))).rejects.toThrow(
      'Legacy run launch is closed'
    );
    expect(await store.recoverRun('after-barrier')).toBeUndefined();
    await expect(
      store.assertGlobalRunBinding(missing.run.id, missing.run.repositoryId)
    ).rejects.toThrow('Legacy run launch is closed');
  } finally {
    await Promise.all([store?.close(), authority?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

it('installs, upgrades, and safely reruns migrations without losing persisted authority', async () => {
  const schema = `forge_upgrade_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  try {
    await migratePostgresAuthoritySchema(migration, runtimeRole, 1);
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    const owner = postgres(ownerConnectionString);
    try {
      await owner.unsafe(
        `insert into "${schema}".forge_runs (id,state,payload) values ($1,$2,$3)`,
        ['preserved-run', 'ACTIVE', JSON.stringify({ run: { id: 'preserved-run' } })]
      );
    } finally {
      await owner.end();
    }
    await migratePostgresAuthoritySchema(migration, runtimeRole);
    await migratePostgresAuthoritySchema(migration, runtimeRole);
    const adapter = await PostgresOrchestrationPersistence.connect(runtime);
    try {
      const rows = await admin.unsafe(
        `select state from "${schema}".forge_runs where id='preserved-run'`
      );
      expect(rows[0]?.state).toBe('ACTIVE');
      const versions = await admin.unsafe(
        `select version from "${schema}".forge_schema_migrations order by version`
      );
      expect(versions.map((row) => row.version)).toEqual([1, POSTGRES_AUTHORITY_SCHEMA_VERSION]);
      await adapter.createRun(durableAuthorityRunRequest('after-upgrade'));
      await expect(adapter.recoverRun('after-upgrade')).resolves.toMatchObject({
        run: { id: 'after-upgrade' }
      });
    } finally {
      await adapter.close();
    }
    await expect(migratePostgresAuthoritySchema(migration, runtimeRole, 1)).rejects.toThrow(
      'cannot downgrade'
    );
  } finally {
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

it('installs M4.2 global authority tables through migration owner and gates runtime startup', async () => {
  const schema = `forge_global_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const runtimeSql = postgres(runtimeConnectionString, { onnotice: () => undefined });
  try {
    await migratePostgresAuthoritySchema(migration, runtimeRole);
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    const existingM41 = await PostgresOrchestrationPersistence.connect(runtime);
    await existingM41.close();
    const tables = await admin`select relname from pg_class
      where relnamespace=${schema}::regnamespace and relkind='r' order by relname`;
    expect(tables.map((row) => row.relname)).toEqual([
      'forge_global_aliases',
      'forge_global_audit',
      'forge_global_claims',
      'forge_global_control',
      'forge_global_generations',
      'forge_global_leases',
      'forge_global_legacy_owners',
      'forge_global_permits',
      'forge_global_run_bindings',
      'forge_global_scopes',
      'forge_global_trust_keys',
      'forge_global_trust_registry',
      'forge_global_trust_revocations',
      'forge_global_workspace_permit_lineages',
      'forge_global_workspace_phases',
      'forge_records',
      'forge_runs',
      'forge_schema_migrations'
    ]);
    const control = await runtimeSql.unsafe(
      `select state from "${schema}".forge_global_control where id=1`
    );
    expect(control).toMatchObject([{ state: 'LEGACY_ALLOWED' }]);
    await expect(
      runtimeSql.unsafe(
        `insert into "${schema}".forge_global_workspace_phases (scope_id,parent_claim_id,phase)
         values ('forged','claim','WORKSPACE_ARMED')`
      )
    ).rejects.toThrow();
    await admin.unsafe(
      `grant insert on "${schema}".forge_global_workspace_phases to "${runtimeRole}"`
    );
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'global authority runtime privileges are incompatible: forge_global_workspace_phases'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    const versions = await admin.unsafe(
      `select version from "${schema}".forge_schema_migrations order by version`
    );
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(
      await runtimeSql.unsafe(
        `select revision,policy_version from "${schema}".forge_global_trust_registry`
      )
    ).toMatchObject([{ revision: '0', policy_version: 'UNCONFIGURED' }]);
    for (const [table, column] of [
      ['forge_global_trust_registry', 'policy_version'],
      ['forge_global_trust_keys', 'state'],
      ['forge_global_trust_revocations', 'digest'],
      ['forge_global_generations', 'state']
    ]) {
      await expect(
        runtimeSql.unsafe(`update "${schema}".${table} set ${column}='forged'`)
      ).rejects.toThrow();
    }
    await admin.unsafe(`grant insert on "${schema}".forge_global_trust_keys to "${runtimeRole}"`);
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'global authority runtime privileges are incompatible: forge_global_trust_keys'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    await expect(
      runtimeSql.unsafe(
        `insert into "${schema}".forge_global_trust_keys (key_id,public_key,state)
         values ('forged','forged','ACTIVE')`
      )
    ).rejects.toThrow();
    const phaseColumns = await admin.unsafe(
      `select column_name from information_schema.columns
        where table_schema=$1 and table_name='forge_global_workspace_phases'
        order by ordinal_position`,
      [schema]
    );
    expect(phaseColumns.map((row) => row.column_name)).toEqual([
      'scope_id',
      'parent_claim_id',
      'phase',
      'setup_plan_digest',
      'execution_plan_digest',
      'execution_generation',
      'workspace_id',
      'signing_key',
      'authorization_digest'
    ]);
    await expect(
      runtimeSql.unsafe(
        `update "${schema}".forge_global_workspace_phases set execution_generation='forged'`
      )
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(`create table "${schema}".unauthorized (id text)`)
    ).rejects.toThrow();
    await admin.unsafe(
      `alter table "${schema}".forge_global_control drop constraint forge_global_control_id_check`
    );
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'global authority constraints are incompatible'
    );
  } finally {
    await runtimeSql.end();
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

it('upgrades existing v5 workspace phases without changing their authority or migration checksum', async () => {
  const schema = `forge_phase_upgrade_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const owner = postgres(ownerConnectionString, { onnotice: () => undefined });
  const runtimeSql = postgres(runtimeConnectionString, { onnotice: () => undefined });
  try {
    await migratePostgresAuthoritySchema(migration, runtimeRole, 5);
    await owner.unsafe(`insert into "${schema}".forge_global_scopes (id,state,next_token)
      values ('scope-old','ACTIVE',7)`);
    await owner.unsafe(`insert into "${schema}".forge_global_claims
      (scope_id,claim_id,owner_json,token,state,version)
      values ('scope-old','parent-old','{}',7,'HELD_UNCERTAIN',1)`);
    await owner.unsafe(`insert into "${schema}".forge_global_workspace_phases
      (scope_id,parent_claim_id,phase)
      values ('scope-old','parent-old','WORKSPACE_UNCERTAIN')`);
    const checksum = await owner.unsafe(
      `select checksum from "${schema}".forge_schema_migrations where version=5`
    );
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    await migratePostgresAuthoritySchema(migration, runtimeRole, 6);
    await migratePostgresAuthoritySchema(migration, runtimeRole, 6);
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    await migratePostgresAuthoritySchema(migration, runtimeRole, 8);
    await migratePostgresAuthoritySchema(migration, runtimeRole, 8);
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    expect(
      await owner.unsafe(`select checksum from "${schema}".forge_schema_migrations where version=5`)
    ).toEqual(checksum);
    expect(
      await runtimeSql.unsafe(`select phase,setup_plan_digest,execution_plan_digest,
        execution_generation,workspace_id from "${schema}".forge_global_workspace_phases
        where scope_id='scope-old' and parent_claim_id='parent-old'`)
    ).toMatchObject([
      {
        phase: 'WORKSPACE_UNCERTAIN',
        setup_plan_digest: null,
        execution_plan_digest: null,
        execution_generation: null,
        workspace_id: null
      }
    ]);
    expect(
      await owner.unsafe(
        `select next_token from "${schema}".forge_global_scopes where id='scope-old'`
      )
    ).toMatchObject([{ next_token: '7' }]);
    await expect(
      runtimeSql.unsafe(`update "${schema}".forge_global_workspace_phases
        set execution_generation='forged' where parent_claim_id='parent-old'`)
    ).rejects.toThrow();
  } finally {
    await runtimeSql.end();
    await owner.unsafe(`drop schema if exists "${schema}" cascade`);
    await owner.end();
  }
});

it('upgrades v3 counters per scope without resetting existing claim tokens or changing v3 checksum', async () => {
  const schema = `forge_scope_upgrade_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const owner = postgres(ownerConnectionString, { onnotice: () => undefined });
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const runtimeSql = postgres(runtimeConnectionString, { onnotice: () => undefined });
  try {
    await migratePostgresAuthoritySchema(migration, runtimeRole, 3);
    const before = await admin.unsafe(
      `select checksum from "${schema}".forge_schema_migrations where version=3`
    );
    await owner.unsafe(
      `insert into "${schema}".forge_global_scopes values ('scope-a','REGISTERING'),('scope-b','REGISTERING')`
    );
    await owner.unsafe(`insert into "${schema}".forge_global_claims values
      ('scope-a','one','{}',5,'RELEASED',1,null),
      ('scope-a','two','{}',9,'HELD_UNCERTAIN',1,null),
      ('scope-b','three','{}',3,'RELEASED',1,null)`);
    await owner.unsafe(`update "${schema}".forge_global_control set next_token=200 where id=1`);
    await migratePostgresAuthoritySchema(migration, runtimeRole, 4);
    await migratePostgresAuthoritySchema(migration, runtimeRole, 4);
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    expect(
      await admin.unsafe(`select id,next_token from "${schema}".forge_global_scopes order by id`)
    ).toMatchObject([
      { id: 'scope-a', next_token: '9' },
      { id: 'scope-b', next_token: '3' }
    ]);
    expect(
      await admin.unsafe(
        `select claim_id,token,state from "${schema}".forge_global_claims order by claim_id`
      )
    ).toMatchObject([
      { claim_id: 'one', token: '5', state: 'RELEASED' },
      { claim_id: 'three', token: '3', state: 'RELEASED' },
      { claim_id: 'two', token: '9', state: 'HELD_UNCERTAIN' }
    ]);
    expect(
      await admin.unsafe(`select checksum from "${schema}".forge_schema_migrations where version=3`)
    ).toEqual(before);
    expect(
      await admin.unsafe(
        `select column_name from information_schema.columns
      where table_schema=$1 and table_name='forge_global_control' and column_name='next_token'`,
        [schema]
      )
    ).toEqual([]);
  } finally {
    await runtimeSql.end();
    await owner.unsafe(`drop schema if exists "${schema}" cascade`);
    await owner.end();
    await admin.end();
  }
});

it.each([
  { table: 'forge_global_aliases', privilege: 'UPDATE(scope_id)', capability: 'UPDATE' },
  { table: 'forge_global_run_bindings', privilege: 'UPDATE(scope_id)', capability: 'UPDATE' },
  { table: 'forge_global_claims', privilege: 'UPDATE(owner_json)', capability: 'UPDATE' },
  { table: 'forge_global_leases', privilege: 'REFERENCES(lease_id)', capability: 'REFERENCES' },
  { table: 'forge_global_permits', privilege: 'UPDATE(token)', capability: 'UPDATE' },
  { table: 'forge_global_audit', privilege: 'UPDATE(evidence)', capability: 'UPDATE' }
])(
  'rejects column-level $privilege on $table and repairs it on v4 migration rerun',
  async ({ table, privilege, capability }) => {
    const schema = `forge_global_column_${++fixtureOrdinal}`;
    const migration = { connectionString: ownerConnectionString, schema, role };
    const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
    const owner = postgres(ownerConnectionString);
    const runtimeSql = postgres(runtimeConnectionString);
    try {
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
      );
      await owner.unsafe(`grant ${privilege} on "${schema}".${table} to "${runtimeRole}"`);
      const before = await runtimeSql.unsafe(
        `select has_table_privilege(current_user, $1, $2) as table_allowed,
          has_any_column_privilege(current_user, $1, $2) as column_allowed`,
        [`${schema}.${table}`, capability]
      );
      expect(before[0]).toMatchObject({
        table_allowed: table === 'forge_global_claims',
        column_allowed: true
      });
      await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
        `global authority runtime privileges are incompatible: ${table}`
      );
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
      );
      const after = await runtimeSql.unsafe(
        `select has_any_column_privilege(current_user, $1, $2) as column_allowed,
          exists (select 1 from pg_attribute a
            cross join lateral aclexplode(a.attacl) grant_entry
            where a.attrelid=$1::regclass and a.attnum > 0
              and grant_entry.grantee=current_user::regrole::oid) as column_grant`,
        [`${schema}.${table}`, capability]
      );
      expect(after[0]).toMatchObject({
        column_allowed: table === 'forge_global_claims',
        column_grant: false
      });
      await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    } finally {
      await runtimeSql.end();
      await owner.unsafe(`drop schema if exists "${schema}" cascade`);
      await owner.end();
    }
  }
);

it.each([
  { table: 'forge_global_control', privilege: 'UPDATE', capability: 'UPDATE' },
  { table: 'forge_global_scopes', privilege: 'INSERT(id)', capability: 'INSERT' },
  { table: 'forge_global_aliases', privilege: 'SELECT(scope_id)', capability: 'SELECT' },
  { table: 'forge_global_run_bindings', privilege: 'INSERT', capability: 'INSERT' },
  { table: 'forge_global_claims', privilege: 'UPDATE(owner_json)', capability: 'UPDATE' },
  { table: 'forge_global_leases', privilege: 'SELECT', capability: 'SELECT' },
  { table: 'forge_global_permits', privilege: 'DELETE', capability: 'DELETE' },
  { table: 'forge_global_legacy_owners', privilege: 'UPDATE', capability: 'UPDATE' },
  { table: 'forge_global_audit', privilege: 'SELECT', capability: 'SELECT' }
])(
  'rejects $privilege grant option on $table and repairs it on v4 migration rerun',
  async ({ table, privilege, capability }) => {
    const schema = `forge_global_grant_${++fixtureOrdinal}`;
    const migration = { connectionString: ownerConnectionString, schema, role };
    const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
    const owner = postgres(ownerConnectionString);
    const runtimeSql = postgres(runtimeConnectionString);
    try {
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
      );
      await owner.unsafe(
        `grant ${privilege} on "${schema}".${table} to "${runtimeRole}" with grant option`
      );
      const check = capability === 'DELETE' ? 'has_table_privilege' : 'has_any_column_privilege';
      const before = await runtimeSql.unsafe(`select ${check}(current_user, $1, $2) as granted`, [
        `${schema}.${table}`,
        `${capability} WITH GRANT OPTION`
      ]);
      expect(before[0]?.granted).toBe(true);
      await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
        `global authority runtime privileges are incompatible: ${table}`
      );
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
      );
      const after = await runtimeSql.unsafe(`select ${check}(current_user, $1, $2) as granted`, [
        `${schema}.${table}`,
        `${capability} WITH GRANT OPTION`
      ]);
      expect(after[0]?.granted).toBe(false);
      await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    } finally {
      await runtimeSql.end();
      await owner.unsafe(`drop schema if exists "${schema}" cascade`);
      await owner.end();
    }
  }
);

it('rejects PUBLIC column ACL drift even when table privileges already cover it', async () => {
  const schema = `forge_global_public_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const owner = postgres(ownerConnectionString);
  const runtimeSql = postgres(runtimeConnectionString);
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await owner.unsafe(`grant update(owner_json) on "${schema}".forge_global_claims to public`);
    const before = await runtimeSql.unsafe(
      `select has_table_privilege(current_user, $1, 'UPDATE') as table_allowed,
        exists (select 1 from pg_attribute a
          cross join lateral aclexplode(a.attacl) grant_entry
          where a.attrelid=$1::regclass and a.attname='owner_json'
            and grant_entry.grantee=0) as public_column_grant`,
      [`${schema}.forge_global_claims`]
    );
    expect(before[0]).toMatchObject({ table_allowed: true, public_column_grant: true });
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'global authority runtime privileges are incompatible: forge_global_claims'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    const after = await runtimeSql.unsafe(
      `select exists (select 1 from pg_attribute a
        cross join lateral aclexplode(a.attacl) grant_entry
        where a.attrelid=$1::regclass and a.attname='owner_json'
          and grant_entry.grantee=0) as public_column_grant`,
      [`${schema}.forge_global_claims`]
    );
    expect(after[0]?.public_column_grant).toBe(false);
    await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
  } finally {
    await runtimeSql.end();
    await owner.unsafe(`drop schema if exists "${schema}" cascade`);
    await owner.end();
  }
});

it('closes PostgreSQL legacy writer creation after the deployment cutover barrier', async () => {
  const schema = `forge_global_gate_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const sql = postgres(runtimeConnectionString, { onnotice: () => undefined });
  const owner = postgres(ownerConnectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    const runId = 'legacy-run';
    await store.createRun(durableAuthorityRunRequest(runId));
    const builder = durableAuthorityInitialDispatch(runId).attempts[0];
    if (builder === undefined) {
      throw new Error('Missing builder fixture');
    }
    await store.persistAttempt(builder);
    const repair = { ...durableAuthorityRepairAttempt('legacy-repair'), runId };
    await store.persistRepairAttempt({ runId, attempt: repair });
    await sql.unsafe(
      `update "${schema}".forge_global_control set state='LEGACY_CUTOVER' where id=1`
    );
    const startedAt = new Date('2026-09-29T00:00:00.000Z');
    const lease = {
      id: 'legacy-builder-lease',
      runId,
      agentId: 'agent-1',
      taskId: 'task-1',
      resource: { type: 'project' as const, projectId: 'project-1' },
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: startedAt,
      lastHeartbeatAt: startedAt
    };
    await expect(
      store.claimBuilderStart({
        runId,
        attempt: { ...builder.attempt, state: 'STARTING', revision: 2, startedAt },
        leases: [lease]
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    await expect(
      store.claimRepairStart({
        runId,
        attempt: { ...repair, state: 'STARTING', revision: 2, startedAt }
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    await expect(
      store.claimIntegrationStart({
        runId,
        taskId: 'task-1',
        workspaceId: 'workspace-1',
        outputAttemptId: 'contract-builder'
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    await expect(store.persistLease({ runId, lease })).rejects.toThrow(
      'Legacy mutation admission is closed'
    );
    await expect(
      store.persistAttempt({
        runId,
        attempt: { ...builder.attempt, state: 'STARTING', revision: 2, startedAt }
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    await expect(
      store.persistRepairAttempt({
        runId,
        attempt: { ...repair, state: 'STARTING', revision: 2, startedAt }
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    const evidence = await sql.unsafe(
      `select kind,key,payload from "${schema}".forge_records where run_id=$1 order by kind,key`,
      [runId]
    );
    expect(
      evidence.filter((row) =>
        ['lease', 'integration-claim', 'repair-history'].includes(String(row.kind))
      )
    ).toEqual([]);
    expect(
      evidence
        .filter((row) => row.kind === 'builder' || row.kind === 'repair')
        .map((row) => JSON.parse(String(row.payload)))
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'PREPARING' }),
        expect.objectContaining({ state: 'PREPARING' })
      ])
    );
  } finally {
    await store?.close();
    await sql.end();
    await owner.unsafe(`drop schema if exists "${schema}" cascade`);
    await owner.end();
  }
});

it.each([0, 12, Number.NaN])(
  'rejects unsupported runtime migration target %s before creating schema objects',
  async (target) => {
    const schema = `forge_bad_target_${++fixtureOrdinal}`;
    const migration = { connectionString: ownerConnectionString, schema, role };
    const admin = postgres(connectionString);
    try {
      await expect(
        Reflect.apply(migratePostgresAuthoritySchema, undefined, [migration, runtimeRole, target])
      ).rejects.toThrow('Unsupported PostgreSQL authority schema target version');
      const schemas = await admin`select 1 from pg_namespace where nspname = ${schema}`;
      expect(schemas).toHaveLength(0);
    } finally {
      await admin.end();
    }
  }
);

it('removes excessive table grants on migration rerun and requires exact runtime privileges', async () => {
  const fixture = await createFixture();
  const owner = postgres(ownerConnectionString);
  const admin = postgres(connectionString);
  const runtime = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    const tables = `"${fixture.schema}".forge_runs, "${fixture.schema}".forge_records`;
    await owner.unsafe(`grant delete on "${fixture.schema}".forge_runs to "${runtimeRole}"`);
    await owner.unsafe(`grant truncate, references, trigger on ${tables} to "${runtimeRole}"`);
    await owner.unsafe(`grant truncate on "${fixture.schema}".forge_records to public`);
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'runtime privileges are incompatible'
    );
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema: fixture.schema, role },
      runtimeRole
    );
    const privileges = await admin.unsafe(
      `select has_table_privilege($1,$2,'DELETE') as runs_delete,
        has_table_privilege($1,$2,'TRUNCATE') as runs_truncate,
        has_table_privilege($1,$2,'REFERENCES') as runs_references,
        has_table_privilege($1,$2,'TRIGGER') as runs_trigger,
        has_table_privilege($1,$3,'DELETE') as records_delete,
        has_table_privilege($1,$3,'TRUNCATE') as records_truncate,
        has_table_privilege($1,$3,'REFERENCES') as records_references,
        has_table_privilege($1,$3,'TRIGGER') as records_trigger`,
      [runtimeRole, `${fixture.schema}.forge_runs`, `${fixture.schema}.forge_records`]
    );
    expect(privileges[0]).toMatchObject({
      runs_delete: false,
      runs_truncate: false,
      runs_references: false,
      runs_trigger: false,
      records_delete: true,
      records_truncate: false,
      records_references: false,
      records_trigger: false
    });
    const publicGrants = await admin.unsafe(
      `select relname, coalesce((select bool_or(a.grantee = 0) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a), false) as public_grant
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname in ('forge_runs','forge_records')`,
      [fixture.schema]
    );
    expect(publicGrants).toHaveLength(2);
    expect(publicGrants.every((row) => row.public_grant === false)).toBe(true);
    const reopened = await PostgresOrchestrationPersistence.connect(runtime);
    await reopened.close();
  } finally {
    await admin.end();
    await owner.end();
    await fixture.close();
  }
});

it.each([
  { table: 'forge_schema_migrations', privilege: 'INSERT(version)', column: 'INSERT' },
  { table: 'forge_schema_migrations', privilege: 'UPDATE(checksum)', column: 'UPDATE' },
  { table: 'forge_schema_migrations', privilege: 'REFERENCES(version)', column: 'REFERENCES' },
  { table: 'forge_runs', privilege: 'REFERENCES(id)', column: 'REFERENCES' },
  { table: 'forge_records', privilege: 'REFERENCES(run_id)', column: 'REFERENCES' }
])(
  'rejects column-level $column on $table and removes it on migration rerun',
  async ({ table, privilege, column }) => {
    const fixture = await createFixture();
    const owner = postgres(ownerConnectionString);
    const runtimeSql = postgres(runtimeConnectionString);
    try {
      await owner.unsafe(`grant ${privilege} on "${fixture.schema}".${table} to "${runtimeRole}"`);
      const rows = await runtimeSql.unsafe(
        `select has_any_column_privilege(current_user, $1, $2) as allowed,
        has_table_privilege(current_user, $1, $2) as table_allowed`,
        [`${fixture.schema}.${table}`, column]
      );
      expect(rows[0]?.allowed).toBe(true);
      expect(rows[0]?.table_allowed).toBe(false);
      if (table === 'forge_schema_migrations' && column === 'UPDATE') {
        await expect(
          runtimeSql.begin(async (tx) => {
            await tx.unsafe(
              `update "${fixture.schema}".forge_schema_migrations set checksum='tampered' where version=1`
            );
            throw new Error('rollback privilege probe');
          })
        ).rejects.toThrow('rollback privilege probe');
      }
      await expect(
        PostgresOrchestrationPersistence.connect({
          connectionString: runtimeConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('runtime privileges are incompatible');
      await migratePostgresAuthoritySchema(
        { connectionString: ownerConnectionString, schema: fixture.schema, role },
        runtimeRole
      );
      const after = await runtimeSql.unsafe(
        `select has_any_column_privilege(current_user, $1, $2) as allowed`,
        [`${fixture.schema}.${table}`, column]
      );
      expect(after[0]?.allowed).toBe(false);
      const reopened = await PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      });
      await reopened.close();
    } finally {
      await runtimeSql.end();
      await owner.end();
      await fixture.close();
    }
  }
);

it.each([
  { table: 'forge_schema_migrations', privilege: 'SELECT' },
  { table: 'forge_schema_migrations', privilege: 'SELECT(checksum)' },
  { table: 'forge_runs', privilege: 'UPDATE' },
  { table: 'forge_records', privilege: 'DELETE' }
])(
  'rejects $privilege grant option on $table and removes it on migration rerun',
  async ({ table, privilege }) => {
    const fixture = await createFixture();
    const owner = postgres(ownerConnectionString);
    try {
      await owner.unsafe(
        `grant ${privilege} on "${fixture.schema}".${table} to "${runtimeRole}" with grant option`
      );
      await expect(
        PostgresOrchestrationPersistence.connect({
          connectionString: runtimeConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('runtime privileges are incompatible');
      await migratePostgresAuthoritySchema(
        { connectionString: ownerConnectionString, schema: fixture.schema, role },
        runtimeRole
      );
      const reopened = await PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      });
      await reopened.close();
    } finally {
      await owner.end();
      await fixture.close();
    }
  }
);

it('rejects non-inherited role membership that can be activated with SET ROLE', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const extraRole = `forge_extra_${process.pid}_${fixtureOrdinal}`;
  let membershipGranted = false;
  try {
    await admin.unsafe(`create role "${extraRole}"`);
    await admin.unsafe(`alter role "${runtimeRole}" noinherit`);
    await admin.unsafe(`grant "${extraRole}" to "${runtimeRole}"`);
    membershipGranted = true;
    const runtime = postgres(runtimeConnectionString);
    try {
      const permissions = await runtime`select
        pg_has_role(current_user, ${extraRole}, 'USAGE') as inherited,
        pg_has_role(current_user, ${extraRole}, 'MEMBER') as member`;
      expect(permissions[0]).toMatchObject({ inherited: false, member: true });
      await runtime.unsafe(`set role "${extraRole}"`);
      const assumed = await runtime`select current_user as name`;
      expect(assumed[0]?.name).toBe(extraRole);
      await runtime`set role none`;
    } finally {
      await runtime.end();
    }
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow('runtime role is not least privileged');
    await admin.unsafe(`revoke "${extraRole}" from "${runtimeRole}"`);
    membershipGranted = false;
    const reopened = await PostgresOrchestrationPersistence.connect({
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    });
    await reopened.close();
  } finally {
    if (membershipGranted) {
      await admin.unsafe(`revoke "${extraRole}" from "${runtimeRole}"`);
    }
    await admin.unsafe(`alter role "${runtimeRole}" inherit`);
    await admin.unsafe(`drop role if exists "${extraRole}"`);
    await admin.end();
    await fixture.close();
  }
});

it('rejects an assumed runtime role whose session can restore a privileged login', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString);
  const proxyRole = `forge_proxy_${process.pid}_${fixtureOrdinal}`;
  let created = false;
  try {
    await admin.unsafe(`create role "${proxyRole}" login createdb`);
    created = true;
    await admin.unsafe(`grant "${runtimeRole}" to "${proxyRole}"`);
    const proxyConnectionString = connectionString.replace(
      'postgresql://',
      `postgresql://${proxyRole}@`
    );
    const proxy = postgres(proxyConnectionString);
    try {
      await proxy.unsafe(`set role "${runtimeRole}"`);
      const identity =
        await proxy`select current_user as current_name, session_user as session_name`;
      expect(identity[0]).toMatchObject({
        current_name: runtimeRole,
        session_name: proxyRole
      });
      await expect(
        assertPostgresAuthoritySchema(proxy, {
          connectionString: runtimeConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('PostgreSQL authority connection login role mismatch');
      await proxy`set role none`;
      const restored = await proxy`select current_user as current_name`;
      expect(restored[0]?.current_name).toBe(proxyRole);
    } finally {
      await proxy.end();
    }
    const assumedRoleConnectionString = `${proxyConnectionString}?options=${encodeURIComponent(`-c role=${runtimeRole}`)}`;
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: assumedRoleConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow('PostgreSQL authority requires an explicit runtime login');
  } finally {
    if (created) {
      await admin.unsafe(`drop role "${proxyRole}"`);
    }
    await admin.end();
    await fixture.close();
  }
});

it('rejects a privileged login even after changing both SQL identities to runtime', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString);
  const proxyRole = `forge_session_proxy_${process.pid}_${fixtureOrdinal}`;
  let created = false;
  try {
    await admin.unsafe(`create role "${proxyRole}" login superuser`);
    created = true;
    const proxyConnectionString = connectionString.replace(
      'postgresql://',
      `postgresql://${proxyRole}@`
    );
    const proxy = postgres(proxyConnectionString);
    try {
      await proxy.unsafe(`set session authorization "${runtimeRole}"`);
      const assumed =
        await proxy`select current_user as current_name, session_user as session_name`;
      expect(assumed[0]).toMatchObject({ current_name: runtimeRole, session_name: runtimeRole });
      await expect(
        assertPostgresAuthoritySchema(proxy, {
          connectionString: proxyConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('PostgreSQL authority requires an explicit runtime login');
      await expect(
        assertPostgresAuthoritySchema(proxy, {
          connectionString: runtimeConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('PostgreSQL authority connection login role mismatch');
      await proxy`reset session authorization`;
      const restored =
        await proxy`select current_user as current_name, session_user as session_name`;
      expect(restored[0]).toMatchObject({ current_name: proxyRole, session_name: proxyRole });
    } finally {
      await proxy.end();
    }
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: `${proxyConnectionString}?options=${encodeURIComponent(`-c session_authorization=${runtimeRole}`)}`,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow('PostgreSQL authority requires an explicit runtime login');
  } finally {
    if (created) {
      await admin.unsafe(`drop role "${proxyRole}"`);
    }
    await admin.end();
    await fixture.close();
  }
});

it('requires an explicit runtime login without startup query parameters', async () => {
  const fixture = await createFixture();
  try {
    for (const candidate of [
      connectionString,
      `${runtimeConnectionString}?options=${encodeURIComponent(`-c session_authorization=${runtimeRole}`)}`,
      `${runtimeConnectionString}?user=forge_proxy`
    ]) {
      await expect(
        PostgresOrchestrationPersistence.connect({
          connectionString: candidate,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('PostgreSQL authority requires an explicit runtime login');
    }
  } finally {
    await fixture.close();
  }
});

it('rejects schema USAGE with grant option and removes it on migration rerun', async () => {
  const fixture = await createFixture();
  const owner = postgres(ownerConnectionString);
  try {
    await owner.unsafe(
      `grant usage on schema "${fixture.schema}" to "${runtimeRole}" with grant option`
    );
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow('runtime privileges are incompatible');
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema: fixture.schema, role },
      runtimeRole
    );
    const reopened = await PostgresOrchestrationPersistence.connect({
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    });
    await reopened.close();
  } finally {
    await owner.end();
    await fixture.close();
  }
});

it('refuses missing, future, and altered migration metadata without repairing the schema', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const runtime = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    await admin.unsafe(
      `insert into "${fixture.schema}".forge_schema_migrations (version, checksum) values (4,'future')`
    );
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    await admin.unsafe(`delete from "${fixture.schema}".forge_schema_migrations where version=4`);
    await admin.unsafe(
      `update "${fixture.schema}".forge_schema_migrations set checksum='tampered' where version=1`
    );
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'migration ledger is incompatible'
    );
    await admin.unsafe(`drop table "${fixture.schema}".forge_schema_migrations`);
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'object is missing'
    );
    const remaining = await admin.unsafe(
      `select count(*)::int as count from "${fixture.schema}".forge_runs`
    );
    expect(remaining[0]?.count).toBe(0);
  } finally {
    await fixture.close();
    await admin.end();
  }
});

it('separates the installer from the restricted runtime role in real PostgreSQL', async () => {
  const fixture = await createFixture();
  const runtimeSql = postgres(runtimeConnectionString);
  const admin = postgres(connectionString, { onnotice: () => undefined });
  try {
    await expect(
      runtimeSql.unsafe(`create table "${fixture.schema}".forbidden (id int)`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(`alter table "${fixture.schema}".forge_runs add column forbidden int`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(`drop table "${fixture.schema}".forge_records`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(`update "${fixture.schema}".forge_schema_migrations set version=88`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(`delete from "${fixture.schema}".forge_schema_migrations`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(
        `insert into "${fixture.schema}".forge_schema_migrations (version,checksum) values (88,'bad')`
      )
    ).rejects.toThrow();
    await expect(runtimeSql.unsafe('create schema forbidden_runtime')).rejects.toThrow();
    await expect(
      runtimeSql.unsafe('create temp table forbidden_runtime (id int)')
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe('create table public.forbidden_runtime (id int)')
    ).rejects.toThrow();
    await expect(
      migratePostgresAuthoritySchema(
        { connectionString: runtimeConnectionString, schema: fixture.schema, role: runtimeRole },
        runtimeRole
      )
    ).rejects.toThrow('must be distinct');
    const privileges = await admin.unsafe(
      `select has_schema_privilege($1,$2,'CREATE') as can_create, has_table_privilege($1,$3,'SELECT,INSERT,UPDATE,DELETE') as can_mutate`,
      [runtimeRole, fixture.schema, `${fixture.schema}.forge_records`]
    );
    expect(privileges[0]).toMatchObject({ can_create: false, can_mutate: true });
    await fixture.store.createRun(durableAuthorityRunRequest('restricted-run'));
    await expect(fixture.peer.recoverRun('restricted-run')).resolves.toMatchObject({
      run: { id: 'restricted-run' }
    });
  } finally {
    await runtimeSql.end();
    await admin.end();
    await fixture.close();
  }
});

it('refuses missing objects and incompatible runtime privileges without startup DDL', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const runtime = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    await admin.unsafe(`revoke update on "${fixture.schema}".forge_records from "${runtimeRole}"`);
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'runtime privileges are incompatible'
    );
    await admin.unsafe(`grant update on "${fixture.schema}".forge_records to "${runtimeRole}"`);
    const owner = postgres(ownerConnectionString);
    try {
      await owner.unsafe(`drop index "${fixture.schema}".forge_records_kind_run_idx`);
    } finally {
      await owner.end();
    }
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'missing required index'
    );
    const index = await admin.unsafe(
      `select 1 from pg_indexes where schemaname=$1 and indexname='forge_records_kind_run_idx'`,
      [fixture.schema]
    );
    expect(index.length).toBe(0);
  } finally {
    await fixture.close();
    await admin.end();
  }
});

it.each([
  {
    name: 'unlogged migration ledger',
    alter: (schema: string) => `alter table "${schema}".forge_schema_migrations set unlogged`,
    message: 'relation semantics are incompatible'
  },
  {
    name: 'row-level security enabled on runs',
    alter: (schema: string) => `alter table "${schema}".forge_runs enable row level security`,
    message: 'relation semantics are incompatible'
  },
  {
    name: 'force row-level security on runs',
    alter: (schema: string) => `alter table "${schema}".forge_runs force row level security`,
    message: 'relation semantics are incompatible'
  },
  {
    name: 'removed migration timestamp default',
    alter: (schema: string) =>
      `alter table "${schema}".forge_schema_migrations alter column applied_at drop default`,
    message: 'column defaults are incompatible'
  },
  {
    name: 'user-defined authority trigger',
    alter: (schema: string) =>
      `create function "${schema}".authority_noop() returns trigger language plpgsql as $$ begin return new; end $$; create trigger authority_noop before update on "${schema}".forge_runs for each row execute function "${schema}".authority_noop()`,
    message: 'triggers or rules are incompatible'
  },
  {
    name: 'user-defined authority rule',
    alter: (schema: string) =>
      `create rule authority_noop as on update to "${schema}".forge_runs do instead nothing`,
    message: 'triggers or rules are incompatible'
  },
  {
    name: 'changed column nullability',
    alter: (schema: string) =>
      `alter table "${schema}".forge_runs alter column state drop not null`,
    message: 'table columns are incompatible'
  },
  {
    name: 'missing evidence primary key',
    alter: (schema: string) =>
      `alter table "${schema}".forge_records drop constraint forge_records_pkey`,
    message: 'table constraints are incompatible'
  },
  {
    name: 'same-named index on the wrong columns',
    alter: (schema: string) =>
      `drop index "${schema}".forge_records_kind_run_idx; create index forge_records_kind_run_idx on "${schema}".forge_records (payload)`,
    message: 'required index or its definition is incompatible'
  }
])('rejects $name at runtime startup without repairing it', async ({ alter, message }) => {
  const fixture = await createFixture();
  const owner = postgres(ownerConnectionString);
  try {
    await owner.unsafe(alter(fixture.schema));
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow(message);
    await expect(
      migratePostgresAuthoritySchema(
        {
          connectionString: ownerConnectionString,
          schema: fixture.schema,
          role
        },
        runtimeRole
      )
    ).rejects.toThrow(message);
  } finally {
    await owner.end();
    await fixture.close();
  }
});

it('fails closed on missing schema, wrong role, and malformed persisted run evidence', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString, { onnotice: () => undefined });
  try {
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: 'forge_missing_schema',
        role: runtimeRole
      })
    ).rejects.toThrow('schema does not exist');
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString,
        schema: fixture.schema,
        role: 'forge_wrong_role'
      })
    ).rejects.toThrow('requires an explicit runtime login');
    await fixture.store.createRun(durableAuthorityRunRequest('corrupted-run'));
    await admin.unsafe(
      `update "${fixture.schema}".forge_runs set payload = '{broken' where id = $1`,
      ['corrupted-run']
    );
    await expect(fixture.peer.recoverRun('corrupted-run')).rejects.toThrow();
  } finally {
    await admin.end();
    await fixture.close();
  }
});

it('rejects a partial sequence-one reevaluation without dispatch attempts', async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.createRun(durableAuthorityRunRequest('partial-run'));
    const dispatch = durableAuthorityInitialDispatch('partial-run');
    await fixture.store.persistReevaluation(dispatch.reevaluation);
    await expect(fixture.peer.ensureInitialDispatch(dispatch)).rejects.toThrow(
      'attempt authority is missing'
    );
    await expect(fixture.store.recoverAttempts('partial-run')).resolves.toEqual([]);
  } finally {
    await fixture.close();
  }
});

it('replays recorded scheduler decisions and reconstructs them after reopening', async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.createRun(durableAuthorityRunRequest('replay-run'));
    const dispatch = durableAuthorityInitialDispatch('replay-run');
    await fixture.store.ensureInitialDispatch(dispatch);
    await expect(
      fixture.peer.replayRun('replay-run', new DeterministicScheduler())
    ).resolves.toHaveLength(1);
    const reopened = await PostgresOrchestrationPersistence.connect({
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    });
    try {
      await expect(reopened.recoverRun('replay-run')).resolves.toMatchObject({
        events: [{ sequence: 1 }],
        decisions: [{ sequence: 1 }]
      });
      await expect(
        reopened.replayRun('replay-run', new DeterministicScheduler())
      ).resolves.toHaveLength(1);
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

it('projects recovered builder, repair, lease, review, verification, timeline, and blocking evidence', async () => {
  const fixture = await createFixture();
  try {
    const runId = 'read-model-run';
    const request = durableAuthorityRunRequest(runId);
    await fixture.store.createRun(request);
    await fixture.store.ensureInitialDispatch(durableAuthorityInitialDispatch(runId));
    const builder = durableAuthorityInitialDispatch(runId).attempts[0].attempt;
    await fixture.store.persistLease({
      runId,
      lease: {
        id: 'blocked-lease',
        runId,
        taskId: 'task-1',
        agentId: 'agent-1',
        resource: { type: 'project', projectId: 'project-1' },
        mode: 'exclusive',
        version: 1,
        state: 'ACTIVE',
        acquiredAt: new Date('2026-09-01T00:02:00.000Z'),
        lastHeartbeatAt: new Date('2026-09-01T00:02:00.000Z')
      }
    });
    const repair = await fixture.store.admitRepairAttemptWithWorkItem({
      attempt: { ...durableAuthorityRepairAttempt('read-repair'), runId },
      maxRepairs: 1,
      createWorkItem: (attempt) => ({ ...durableAuthorityRepairWorkItem(attempt), runId })
    });
    const verified = {
      id: 'read-verification',
      runId,
      taskId: 'task-1',
      attemptId: repair.id,
      workspaceId: 'workspace-1',
      workspaceRevision: 1,
      workspaceChangeFingerprint: `sha256:${'c'.repeat(64)}`,
      verificationPolicyFingerprint: request.run.authority.verificationPolicyFingerprint,
      status: 'passed' as const,
      verifiedAt: '2026-09-01T00:04:00.000Z'
    };
    await fixture.store.persistVerificationEvidence({
      ...verified,
      fingerprint: taskVerificationEvidenceFingerprint(verified)
    });
    await fixture.store.persistReview({
      runId,
      taskId: 'task-1',
      iteration: 2,
      subject: { ...repair.parentReviewSubject, outputAttemptId: repair.id },
      review: { recommendation: 'accept', summary: 'Repair accepted.', findings: [] }
    });
    await fixture.store.persistReevaluation({
      event: {
        runId,
        sequence: 2,
        occurredAt: '2026-09-01T00:05:00.000Z',
        event: { type: 'lease-blocked', taskId: 'task-1', leaseId: 'blocked-lease' }
      },
      decision: {
        runId,
        sequence: 2,
        inputSnapshot: { taskStates: [{ taskId: 'task-1', state: 'RUNNING' }], runtimeBlocks: [] },
        decision: {
          taskDecisions: [
            {
              taskId: 'task-1',
              action: 'block',
              fromState: 'RUNNING',
              toState: 'BLOCKED',
              reasons: [
                { type: 'runtime-blocked', blockers: [{ type: 'lease', leaseId: 'blocked-lease' }] }
              ]
            }
          ]
        }
      },
      transitions: [
        { runId, sequence: 2, taskId: 'task-1', fromState: 'RUNNING', toState: 'BLOCKED' }
      ]
    });
    const reopened = await PostgresOrchestrationPersistence.connect({
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    });
    try {
      const result = await new ForgeReadModel({
        persistence: reopened,
        workflowId: (id) => `forge-run:${id}`
      }).read(runId);
      expect(result).toMatchObject({
        runId,
        correlation: { runId, workflowId: `forge-run:${runId}` },
        leases: [
          {
            id: 'blocked-lease',
            state: 'ACTIVE',
            resource: { type: 'project', projectId: 'project-1' }
          }
        ],
        timeline: [
          { sequence: 1, type: 'run-started' },
          { sequence: 2, type: 'lease-blocked', correlation: { taskId: 'task-1' } }
        ],
        tasks: [
          {
            id: 'task-1',
            state: 'BLOCKED',
            currentBlockingReason: {
              type: 'runtime-blocked',
              blockers: [{ type: 'lease', leaseId: 'blocked-lease' }]
            },
            attempts: [
              { id: builder.id, kind: 'builder' },
              {
                id: repair.id,
                kind: 'repair',
                correlation: { attemptId: builder.id, repairAttemptId: repair.id }
              }
            ],
            verification: [
              {
                id: 'read-verification',
                correlation: { attemptId: builder.id, repairAttemptId: repair.id }
              }
            ],
            reviews: [
              { iteration: 2, correlation: { attemptId: builder.id, repairAttemptId: repair.id } }
            ]
          }
        ]
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

it('permits one builder claim after two competing transactions block on the same run row', async () => {
  const fixture = await createFixture();
  const holder = postgres(connectionString);
  const observer = postgres(connectionString);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  try {
    await fixture.store.createRun(durableAuthorityRunRequest('competing-run'));
    await fixture.store.ensureInitialDispatch(durableAuthorityInitialDispatch('competing-run'));
    const holding = holder.begin(async (tx) => {
      await tx.unsafe(`select id from "${fixture.schema}".forge_runs where id=$1 for update`, [
        'competing-run'
      ]);
      markLocked();
      await gate;
    });
    try {
      await locked;
      const starting = {
        ...durableAuthorityInitialDispatch('competing-run').attempts[0].attempt,
        state: 'STARTING' as const,
        revision: 2,
        startedAt: new Date('2026-09-01T00:02:00.000Z')
      };
      const claims = [
        fixture.store.claimBuilderStart({ runId: 'competing-run', attempt: starting, leases: [] }),
        fixture.peer.claimBuilderStart({ runId: 'competing-run', attempt: starting, leases: [] })
      ];
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows =
          await observer`select count(*)::int as blocked from pg_stat_activity where query like '%forge_runs where id=$1 for update%' and cardinality(pg_blocking_pids(pid)) > 0`;
        if (Number(rows[0]?.blocked) === 2) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      release();
      await holding;
      const outcomes = await Promise.allSettled(claims);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      await expect(fixture.peer.recoverAttempts('competing-run')).resolves.toMatchObject([
        { attempt: { state: 'STARTING', revision: 2 } }
      ]);
    } finally {
      release();
      await holding;
    }
  } finally {
    await Promise.all([holder.end(), observer.end()]);
    await fixture.close();
  }
}, 15_000);

it('serializes cancellation before three genuinely blocked mutation claims', async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.createRun(durableAuthorityRunRequest('race-run'));
    await fixture.store.ensureInitialDispatch(durableAuthorityInitialDispatch('race-run'));
    const admitted = await fixture.store.admitRepairAttemptWithWorkItem({
      attempt: { ...durableAuthorityRepairAttempt('race-repair'), runId: 'race-run' },
      maxRepairs: 1,
      createWorkItem: (attempt) => ({
        ...durableAuthorityRepairWorkItem(attempt),
        runId: 'race-run'
      })
    });
    const holder = postgres(connectionString);
    const observer = postgres(connectionString);
    let unlock!: () => void;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holding = holder.begin(async (tx) => {
      await tx.unsafe(`select id from "${fixture.schema}".forge_runs where id = $1 for update`, [
        'race-run'
      ]);
      markLocked();
      await release;
      await tx.unsafe(
        `update "${fixture.schema}".forge_runs set state = 'CANCEL_REQUESTED' where id = 'race-run'`
      );
    });
    try {
      await locked;
      const starting = {
        ...durableAuthorityInitialDispatch('race-run').attempts[0].attempt,
        state: 'STARTING' as const,
        revision: 2,
        startedAt: new Date('2026-09-01T00:02:00.000Z')
      };
      const pending = [
        fixture.peer.claimBuilderStart({
          runId: 'race-run',
          attempt: starting,
          leases: [
            {
              id: 'race-lease',
              runId: 'race-run',
              agentId: 'agent-1',
              taskId: 'task-1',
              resource: { type: 'project' as const, projectId: 'project-1' },
              mode: 'exclusive' as const,
              state: 'ACTIVE' as const,
              version: 1,
              acquiredAt: new Date(),
              lastHeartbeatAt: new Date()
            }
          ]
        }),
        fixture.store.claimRepairStart({
          runId: 'race-run',
          attempt: { ...admitted, state: 'STARTING', revision: 2, startedAt: new Date() }
        }),
        fixture.peer.claimIntegrationStart({
          runId: 'race-run',
          taskId: 'task-1',
          workspaceId: 'workspace-1',
          outputAttemptId: 'contract-builder'
        })
      ];
      // pg_blocking_pids proves the claim reached PostgreSQL and is blocked on the locked run row.
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows =
          await observer`select count(*)::int as blocked from pg_stat_activity where query like '%forge_runs where id=$1 for update%' and cardinality(pg_blocking_pids(pid)) > 0`;
        if (Number(rows[0]?.blocked) === 3) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      unlock();
      await holding;
      const outcomes = await Promise.allSettled(pending);
      expect(outcomes).toHaveLength(3);
      expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
      await expect(fixture.store.hasActiveIntegrationClaim('race-run')).resolves.toBe(false);
      await expect(fixture.peer.recoverAttempts('race-run')).resolves.toMatchObject([
        { attempt: { state: 'PREPARING', revision: 1 } }
      ]);
      await expect(fixture.peer.recoverRepairAttempts('race-run')).resolves.toMatchObject([
        { attempt: { state: 'PREPARING', revision: 1 } }
      ]);
      await expect(fixture.peer.recoverLeases('race-run')).resolves.toEqual([]);
    } finally {
      unlock();
      await holding;
      await Promise.all([holder.end(), observer.end()]);
    }
  } finally {
    await fixture.close();
  }
}, 15_000);
