import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import postgres from 'postgres';
import type { CreatePersistedRunRequest } from '@ai-native-software-delivery-orchestrator/domain';
import { taskLeasePlanFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { fingerprintPlanValue } from '@ai-native-software-delivery-orchestrator/planning';
import {
  migratePostgresAuthoritySchema,
  PostgresExecutionGenerationIssuer,
  PostgresGlobalMutationAuthority,
  PostgresOrchestrationPersistence,
  POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import {
  DockerWorkspaceGenerationSupervisor,
  GitWorkspaceManager,
  GitWorkspaceStateInspector
} from '@ai-native-software-delivery-orchestrator/workspace-git';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { PostgresWorkspaceRecoveryObserver } from './postgres-workspace-recovery.js';
import { PostgresWorkspaceHandoff } from './postgres-workspace-handoff.js';
import {
  WorkspaceRecoveryAttestor,
  verifyWorkspaceRecoveryAttestation
} from './workspace-recovery-attestation.js';

let root: string;
let owner: string;
let runtime: string;
let issuerLogin: string;
let admin: ReturnType<typeof postgres>;
const roles = {
  migration: `forge_recovery_owner_${process.pid}`,
  runtime: `forge_recovery_runtime_${process.pid}`,
  trust: `forge_recovery_trust_${process.pid}`,
  issuer: `forge_recovery_issuer_${process.pid}`,
  setup: `forge_recovery_setup_${process.pid}`,
  recovery: `forge_recovery_principal_${process.pid}`
};

const availablePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Missing recovery PostgreSQL fixture port'));
      } else {
        server.close(() => resolve(address.port));
      }
    });
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'forge-recovery-pg-'));
  const data = join(root, 'data');
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { stdio: 'pipe' });
  const port = await availablePort();
  execFileSync(
    'pg_ctl',
    ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'],
    { stdio: 'pipe' }
  );
  const url = `postgresql://127.0.0.1:${port}/postgres`;
  admin = postgres(url, { onnotice: () => undefined });
  for (const role of Object.values(roles)) {
    await admin.unsafe(`create role "${role}" login`);
  }
  await admin`revoke create, temporary on database postgres from public`;
  await admin`revoke create on schema public from public`;
  await admin.unsafe(`grant create on database postgres to "${roles.migration}"`);
  owner = `postgresql://${roles.migration}@127.0.0.1:${port}/postgres`;
  runtime = `postgresql://${roles.runtime}@127.0.0.1:${port}/postgres`;
  issuerLogin = `postgresql://${roles.issuer}@127.0.0.1:${port}/postgres`;
}, 90_000);

afterAll(async () => {
  await admin?.end();
  if (root !== undefined) {
    try {
      execFileSync('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop'], {
        stdio: 'pipe'
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

it.each(['completed', 'orphaned'] as const)(
  'revokes a real PostgreSQL generation and hands off a %s Git permit only after inspection',
  async (permitState) => {
    const schema = `recovery_${process.pid}`;
    const integration = mkdtempSync(join(tmpdir(), 'forge-recovery-repo-'));
    const worktree = `${integration}-worktree`;
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: integration, encoding: 'utf8' }).trim();
    let authority: PostgresGlobalMutationAuthority | undefined;
    let issuer: PostgresExecutionGenerationIssuer | undefined;
    let store: PostgresOrchestrationPersistence | undefined;
    let containerId: string | undefined;
    try {
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Recovery Test');
      git('config', 'user.email', 'recovery@example.test');
      git('commit', '--allow-empty', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      const config = { connectionString: runtime, role: roles.runtime, schema };
      await migratePostgresAuthoritySchema(
        { connectionString: owner, role: roles.migration, schema },
        roles.runtime,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
        {
          trustAdminRole: roles.trust,
          generationIssuerRole: roles.issuer,
          setupAdmissionRole: roles.setup,
          recoveryRole: roles.recovery
        }
      );
      store = await PostgresOrchestrationPersistence.connect(config);
      authority = await PostgresGlobalMutationAuthority.connect(config);
      issuer = await PostgresExecutionGenerationIssuer.connect({
        connectionString: issuerLogin,
        role: roles.issuer,
        schema
      });
      const scopeId = await authority.registerScope('repo');
      const request: CreatePersistedRunRequest = {
        run: {
          id: 'recovery-run',
          repositoryId: 'repo',
          state: 'ACTIVE',
          createdAt: '2026-09-01T00:00:00.000Z',
          authority: {
            artifactId: 'artifact',
            artifactRevision: 1,
            approvalId: 'approval',
            planFingerprint: `sha256:${'1'.repeat(64)}`,
            approvalFingerprint: `sha256:${'2'.repeat(64)}`,
            claimFingerprint: `sha256:${'3'.repeat(64)}`,
            executionFingerprint: `sha256:${'4'.repeat(64)}`,
            repositoryRoot: integration,
            baseCommit: base,
            workingTreeFingerprint: `sha256:${'5'.repeat(64)}`,
            repositoryFactsFingerprint: `sha256:${'6'.repeat(64)}`,
            sharedResourcePolicyFingerprint: `sha256:${'7'.repeat(64)}`,
            verificationPolicyFingerprint: `sha256:${'8'.repeat(64)}`,
            codeReviewPolicyFingerprint: `sha256:${'9'.repeat(64)}`
          }
        },
        tasks: [
          {
            id: 'task',
            title: 'Recovery task',
            goal: 'Observe safely',
            dependencies: [],
            expectedReads: [],
            expectedWrites: [],
            sharedResources: [],
            verification: []
          }
        ],
        taskBindings: [
          {
            runId: 'recovery-run',
            taskId: 'task',
            agentId: 'agent',
            leasePlan: {
              taskId: 'task',
              predictedResources: [{ type: 'project', projectId: 'project' }],
              source: 'manual'
            },
            workspace: {
              id: 'workspace',
              runId: 'recovery-run',
              taskId: 'task',
              integrationRepositoryPath: integration,
              workspacePath: worktree,
              branchName: 'forge/recovery/task',
              baseRef: 'main',
              integrationRef: 'main'
            }
          }
        ],
        hardConflicts: [],
        riskConflicts: [],
        scheduleOptions: { maxConcurrency: 1 }
      };
      await store.createRun(request);
      await authority.bindRun(request.run.id, request.run.repositoryId);
      await authority.beginLegacyCutover();
      for (const historical of await authority.recoverLegacyOwners()) {
        await authority.settleLegacyOwner(
          historical.key,
          'The run was stopped before global activation.'
        );
      }
      await authority.completeLegacyCutover('Previous writers stopped');
      await authority.activateScope(scopeId);
      await store.persistAttempt({
        runId: request.run.id,
        attempt: {
          id: 'attempt',
          runId: request.run.id,
          taskId: 'task',
          agentId: 'agent',
          workspaceId: 'workspace',
          leasePlanFingerprint: taskLeasePlanFingerprint(request.taskBindings[0].leasePlan),
          state: 'PREPARING',
          revision: 1
        }
      });
      const workspace = await new GitWorkspaceManager().create(request.taskBindings[0].workspace);
      await store.persistWorkspace({ runId: request.run.id, workspace });
      // Test-only owner seeds the already-finished setup phase; the observer never
      // receives owner access, a Git completion secret, or setup credentials.
      await admin.unsafe(
        `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='builder' and key=$2`,
        [
          request.run.id,
          'attempt',
          JSON.stringify({
            id: 'attempt',
            runId: request.run.id,
            taskId: 'task',
            agentId: 'agent',
            workspaceId: 'workspace',
            leasePlanFingerprint: taskLeasePlanFingerprint(request.taskBindings[0].leasePlan),
            state: 'STARTING',
            revision: 2,
            startedAt: '2026-09-01T00:00:01.000Z'
          })
        ]
      );
      const parentOwner = {
        runId: request.run.id,
        taskId: 'task',
        attemptId: 'attempt',
        agentId: 'agent',
        workspaceId: 'workspace'
      };
      await admin.unsafe(
        `insert into "${schema}".forge_global_claims (scope_id,claim_id,owner_json,token,state,version,evidence) values ($1,'parent',$2,1,$3,$4,'Git outcome requires review')`,
        [
          scopeId,
          JSON.stringify(parentOwner),
          permitState === 'completed' ? 'HELD_UNCERTAIN' : 'ACTIVE',
          permitState === 'completed' ? 2 : 1
        ]
      );
      await admin.unsafe(`update "${schema}".forge_global_scopes set next_token=1 where id=$1`, [
        scopeId
      ]);
      await admin.unsafe(
        `insert into "${schema}".forge_global_leases (scope_id,claim_id,lease_id,resource_json) values ($1,'parent','lease','{"type":"repository"}')`,
        [scopeId]
      );
      await admin.unsafe(
        `insert into "${schema}".forge_global_workspace_phases (scope_id,parent_claim_id,phase,setup_plan_digest,execution_plan_digest,workspace_id,signing_key,authorization_digest,execution_generation) values ($1,'parent',$3,'setup',$2,'workspace','key','authorization','generation')`,
        [
          scopeId,
          fingerprintPlanValue(request.taskBindings[0].leasePlan).slice(7),
          permitState === 'completed' ? 'WORKSPACE_UNCERTAIN' : 'WORKSPACE_ARMED'
        ]
      );
      await admin.unsafe(
        `insert into "${schema}".forge_global_workspace_permit_lineages (scope_id,parent_claim_id,permit_id,owner_json,token,generation_id,workspace_id,verifier,completed) values ($1,'parent','permit',$2,1,'generation','workspace','verifier',$3)`,
        [scopeId, JSON.stringify(parentOwner), permitState === 'completed']
      );
      await admin.unsafe(
        `insert into "${schema}".forge_global_generations (id,scope_id,parent_claim_id,run_id,task_id,attempt_id,workspace_id,supervisor_id,setup_plan_digest,execution_plan_digest,state) values ('generation',$1,'parent',$2,'task','attempt','workspace','supervisor','setup',$3,'ISSUED')`,
        [scopeId, request.run.id, fingerprintPlanValue(request.taskBindings[0].leasePlan).slice(7)]
      );
      const testGeneration = {
        scopeId,
        parentClaimId: 'parent',
        generationId: 'generation',
        workspaceId: 'workspace',
        workspacePath: realpathSync(worktree),
        workspaceDevice: '1',
        workspaceInode: '2',
        supervisorId: 'supervisor',
        containerId: 'a'.repeat(64)
      };
      const pinnedImage = process.env['FORGE_TEST_DOCKER_IMAGE'];
      const realSupervisor = pinnedImage
        ? new DockerWorkspaceGenerationSupervisor({
            supervisorId: 'supervisor',
            image: pinnedImage
          })
        : undefined;
      const generation =
        realSupervisor === undefined
          ? testGeneration
          : await realSupervisor.launch({
              scopeId,
              parentClaimId: 'parent',
              generationId: 'generation',
              workspaceId: 'workspace',
              workspacePath: worktree,
              command: ['node', '-e', 'setInterval(() => {}, 1000)']
            });
      if (realSupervisor !== undefined) {
        containerId = generation.containerId;
      }
      const stop = vi.fn(async () => ({ generation, exitCode: 137 }));
      const inspect = vi.fn(
        async (
          _generation: typeof generation,
          inspectRequest: Parameters<GitWorkspaceStateInspector['inspect']>[0]
        ) => new GitWorkspaceStateInspector().inspect(inspectRequest)
      );
      const supervisor = realSupervisor ?? {
        stopAndVerify: stop,
        assertStopped: vi.fn(async () => {}),
        inspectStoppedWorkspace: inspect
      };
      const observer = new PostgresWorkspaceRecoveryObserver({
        authority,
        issuer,
        persistence: store,
        supervisor
      });
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      await admin.unsafe(
        `update "${schema}".forge_global_trust_registry set policy_version='git-workspace-setup-v1' where id=1`
      );
      await admin.unsafe(
        `insert into "${schema}".forge_global_trust_keys (key_id,public_key,state) values ('key',$1,'ACTIVE')`,
        [publicKey.export({ type: 'spki', format: 'pem' })]
      );
      const attestor = new WorkspaceRecoveryAttestor(
        observer,
        'independent-recovery',
        privateKey.export({ type: 'pkcs8', format: 'pem' })
      );
      const attestation =
        permitState === 'completed'
          ? await attestor.attest(generation)
          : await attestor.attestPendingPermit(generation);
      expect(
        verifyWorkspaceRecoveryAttestation({
          attestation,
          trustedPublicKeys: new Map([
            ['independent-recovery', publicKey.export({ type: 'spki', format: 'pem' })]
          ])
        })
      ).toEqual(attestation);
      expect(attestation.observation).toMatchObject({
        authority: {
          parentState: permitState === 'completed' ? 'HELD_UNCERTAIN' : 'ACTIVE',
          phase: permitState === 'completed' ? 'WORKSPACE_UNCERTAIN' : 'WORKSPACE_ARMED',
          generation: { state: 'REVOKED' }
        },
        git: { workspaceId: 'workspace', headCommit: base, clean: true }
      });
      if (realSupervisor === undefined) {
        expect(stop).toHaveBeenCalledOnce();
        expect(inspect).toHaveBeenCalledOnce();
      } else {
        await realSupervisor.assertStopped(generation);
        expect(attestation.generation.containerId).toBe(containerId);
      }
      expect(
        await admin.unsafe(
          `select state from "${schema}".forge_global_generations where id='generation'`
        )
      ).toMatchObject([{ state: 'REVOKED' }]);
      expect(
        await admin.unsafe(
          `select state,version from "${schema}".forge_global_claims where claim_id='parent'`
        )
      ).toMatchObject([
        {
          state: permitState === 'completed' ? 'HELD_UNCERTAIN' : 'ACTIVE',
          version: permitState === 'completed' ? '2' : '1'
        }
      ]);
      expect(
        await admin.unsafe(`select count(*)::integer as count from "${schema}".forge_global_claims`)
      ).toMatchObject([{ count: 1 }]);
      const recovery = await PostgresWorkspaceHandoff.connect({
        recovery: {
          connectionString: `postgresql://${roles.recovery}@${runtime.split('@')[1]}`,
          role: roles.recovery,
          schema
        },
        runtime: config,
        issuer: { connectionString: issuerLogin, role: roles.issuer, schema },
        observer,
        keyId: 'independent-recovery',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' })
      });
      try {
        await expect(
          recovery.settle(generation, {
            ...attestation,
            observation: {
              ...attestation.observation,
              git: { ...attestation.observation.git, headCommit: 'f'.repeat(40) }
            }
          })
        ).rejects.toThrow('signature is invalid');
        await recovery.settle(generation, attestation);
        const child = await recovery.handoff(
          generation,
          attestation,
          taskLeasePlanFingerprint(request.taskBindings[0].leasePlan)
        );
        expect(child).toMatchObject({
          claimId: expect.stringMatching(/^execution-[0-9a-f]{64}$/),
          token: 2
        });
        expect(
          await recovery.handoff(
            generation,
            attestation,
            taskLeasePlanFingerprint(request.taskBindings[0].leasePlan)
          )
        ).toEqual(child);
        const claims = await admin.unsafe(
          `select claim_id,state,token from "${schema}".forge_global_claims order by token`
        );
        expect(claims).toMatchObject([
          { claim_id: 'parent', state: 'RELEASED', token: '1' },
          { claim_id: expect.stringMatching(/^execution-/), state: 'ACTIVE', token: '2' }
        ]);
      } finally {
        await recovery.close();
      }
    } finally {
      if (containerId) {
        execFileSync('docker', ['rm', '-f', containerId]);
      }
      await Promise.all([authority?.close(), issuer?.close(), store?.close()]);
      await admin.unsafe(`drop schema if exists "${schema}" cascade`);
      rmSync(worktree, { recursive: true, force: true });
      rmSync(integration, { recursive: true, force: true });
    }
  },
  30_000
);
