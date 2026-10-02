import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import postgres from 'postgres';
import {
  DockerPiSessionGateway,
  PiAgentRunner
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type { CreatePersistedRunRequest } from '@ai-native-software-delivery-orchestrator/domain';
import {
  taskLeasePlanFingerprint,
  taskVerificationEvidenceFingerprint
} from '@ai-native-software-delivery-orchestrator/domain';
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
  GitRepositorySnapshotProvider,
  GitWorkspaceStateInspector
} from '@ai-native-software-delivery-orchestrator/workspace-git';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { PostgresWorkspaceRecoveryObserver } from './postgres-workspace-recovery.js';
import { PostgresWorkspaceHandoff } from './postgres-workspace-handoff.js';
import { PostgresExecutionChildTools } from './postgres-execution-child.js';
import { PostgresExecutionChildRunner } from './postgres-execution-child-runner.js';
import { PostgresRepairRunner } from './postgres-repair-runner.js';
import { PostgresIntegrationRunner } from './postgres-integration-runner.js';
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

it.each([
  ['completed', 'takeover'],
  ['orphaned', 'takeover'],
  ['completed', 'success'],
  ['completed', 'failure'],
  ['completed', 'cancel'],
  ['completed', 'restart'],
  ['completed', 'inflight'],
  ['completed', 'concurrent'],
  ['completed', 'repair-success'],
  ['completed', 'repair-cancel'],
  ['completed', 'repair-restart'],
  ['completed', 'repair-failure'],
  ['completed', 'repair-inflight'],
  ['completed', 'repair-unconfirmed'],
  ['completed', 'repair-trust'],
  ['completed', 'integration-success'],
  ['completed', 'integration-denied'],
  ['completed', 'integration-failure'],
  ['completed', 'integration-cancel'],
  ['completed', 'integration-restart'],
  ['completed', 'integration-unconfirmed'],
  ['completed', 'integration-persist-failure'],
  ['completed', 'integration-inflight'],
  ['completed', 'integration-trust'],
  ['completed', 'integration-blocked'],
  ['completed', 'unconfirmed']
] as const)(
  'hands off a %s Git permit and executes the %s child lifecycle',
  async (permitState, lifecycle) => {
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
      writeFileSync(join(integration, 'approved.txt'), 'before');
      writeFileSync(join(integration, 'resumed.txt'), 'before');
      writeFileSync(join(integration, 'after-cancel.txt'), 'before');
      git('add', 'approved.txt', 'resumed.txt', 'after-cancel.txt');
      git('commit', '-m', 'base');
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
              predictedResources:
                lifecycle.startsWith('integration-') && lifecycle !== 'integration-denied'
                  ? [{ type: 'repository' }]
                  : [{ type: 'project', projectId: 'project' }],
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
        if ('blocked' in child) {
          throw new Error('The approved execution child was blocked');
        }
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
        const agentRequest = {
          runId: request.run.id,
          taskId: 'task',
          task: request.tasks[0],
          attempt: {
            id: 'attempt',
            runId: request.run.id,
            taskId: 'task',
            agentId: 'agent',
            workspaceId: 'workspace',
            leasePlanFingerprint: taskLeasePlanFingerprint(request.taskBindings[0].leasePlan),
            state: 'STARTING' as const,
            revision: 2,
            startedAt: new Date('2026-09-01T00:00:01.000Z')
          },
          workspace,
          instructions: 'Write the approved project output.',
          onStarted: async () => {}
        };
        const executionStore = store;
        if (executionStore === undefined) {
          throw new Error('Missing PostgreSQL execution persistence');
        }
        const attachTools = (connection: PostgresGlobalMutationAuthority) =>
          new PostgresExecutionChildTools({
            authority: connection,
            persistence: executionStore,
            resolveResource: () => ({ type: 'project' as const, projectId: 'project' }),
            resolveFileId: (path) => path
          }).attach(scopeId, 'parent', agentRequest);
        const tools = await attachTools(authority);
        if (lifecycle.startsWith('integration-') && lifecycle !== 'integration-denied') {
          expect(
            await tools.executeRepositoryMutation(async () => 'approved repository execution')
          ).toBe('approved repository execution');
        } else {
          await expect(tools.executeRepositoryMutation(async () => 'unapproved')).rejects.toThrow();
        }
        expect(await tools.write('approved.txt', 'first')).toMatchObject({ status: 'written' });
        expect(readFileSync(join(worktree, 'approved.txt'), 'utf8')).toBe('first');
        const resumedAuthority = await PostgresGlobalMutationAuthority.connect(config);
        try {
          const resumed = await attachTools(resumedAuthority);
          expect(await resumed.write('resumed.txt', 'second')).toMatchObject({ status: 'written' });
          const runner = new PiAgentRunner({
            gateway:
              process.env.FORGE_TEST_DOCKER_IMAGE !== undefined && lifecycle === 'takeover'
                ? new DockerPiSessionGateway({
                    image: process.env.FORGE_TEST_DOCKER_IMAGE,
                    executable: '/usr/local/bin/node',
                    args: [
                      '-e',
                      `
                    const fs = require('node:fs');
                    const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
                    require('node:readline').createInterface({input:process.stdin}).on('line', (line) => {
                      const message = JSON.parse(line);
                      if(message.type === 'start') {
                        if(fs.existsSync('/workspace') || process.env.PGDATABASE) throw new Error('host access');
                        send({type:'started',sessionId:'container-session'});
                      } else if(message.type === 'started-ack') {
                        send({type:'tool',id:'1',call:{name:'forge_write',path:'approved.txt',content:'through-pi'}});
                      } else if(message.type === 'tool-result') {
                        if(message.result.isError) throw new Error(message.result.content);
                        send({type:'completed',sessionId:'container-session'});
                        process.exit(0);
                      }
                    });
                  `
                    ]
                  })
                : {
                    start: async (session) => {
                      await session.onStarted('controlled-session');
                      const outcome = await session.executeTool({
                        name: 'forge_write',
                        path: 'approved.txt',
                        content: 'through-pi'
                      });
                      if (outcome.isError) {
                        throw new Error(outcome.content);
                      }
                      return { sessionId: 'controlled-session' };
                    }
                  },
            createTools: () => resumed
          });
          expect((await runner.run(agentRequest)).status).toBe('completed');
          expect(readFileSync(join(worktree, 'approved.txt'), 'utf8')).toBe('through-pi');
          expect((await store.recoverRun(request.run.id))?.impacts).toHaveLength(1);
          await admin.unsafe(
            `update "${schema}".forge_global_trust_keys set state='REVOKED' where key_id='key'`
          );
          await expect(resumed.write('after-cancel.txt', 'forbidden')).rejects.toThrow(
            'trust is no longer current'
          );
          expect(readFileSync(join(worktree, 'after-cancel.txt'), 'utf8')).toBe('before');
          await expect(attachTools(resumedAuthority)).rejects.toThrow('trust is no longer current');
          await admin.unsafe(
            `update "${schema}".forge_global_trust_keys set state='ACTIVE' where key_id='key'`
          );
          if (lifecycle !== 'takeover') {
            const childIdentity = {
              scopeId,
              parentClaimId: 'parent',
              claimId: child.claimId,
              owner: parentOwner,
              token: child.token
            };
            const stopConfirmation = vi.fn(
              async () => 'Independent test supervisor confirmed exit'
            );
            const toolsFactory = new PostgresExecutionChildTools({
              authority: resumedAuthority,
              persistence: executionStore,
              resolveResource: () => ({ type: 'project', projectId: 'project' }),
              resolveFileId: (path) => path
            });
            let launches = 0;
            const lifecycleRunner = new PostgresExecutionChildRunner({
              authority: resumedAuthority,
              tools: toolsFactory,
              ...(lifecycle === 'unconfirmed' ? {} : { confirmStopped: stopConfirmation }),
              createRunner: (fencedTools) => {
                launches += 1;
                return {
                  run: async (runRequest) => {
                    expect(
                      (await executionStore.recoverRun(request.run.id))?.attempts[0]?.attempt
                    ).toMatchObject({
                      state: 'RUNNING',
                      revision: 3,
                      sessionRef: { backend: 'forge-launch-reservation' }
                    });
                    if (lifecycle === 'concurrent') {
                      await expect(
                        lifecycleRunner.run(scopeId, 'parent', agentRequest)
                      ).rejects.toThrow();
                      expect(launches).toBe(1);
                    }
                    await runRequest.onStarted({
                      sessionRef: { backend: 'pi', value: 'lifecycle-session' }
                    });
                    expect(
                      (await executionStore.recoverRun(request.run.id))?.attempts[0]?.attempt
                    ).toMatchObject({
                      state: 'RUNNING',
                      revision: 4,
                      sessionRef: { backend: 'pi', value: 'lifecycle-session' }
                    });
                    if (lifecycle === 'failure') {
                      throw new Error('External session lost after establishment');
                    }
                    if (lifecycle === 'cancel') {
                      await executionStore.requestCancellation(request.run.id);
                      await expect(
                        fencedTools.write('after-cancel.txt', 'forbidden')
                      ).rejects.toThrow();
                      return { status: 'cancelled', detail: 'Session cancellation confirmed' };
                    }
                    if (lifecycle === 'inflight') {
                      await resumedAuthority.beginFencedMutation({
                        ...childIdentity,
                        resource: { type: 'project', projectId: 'project' }
                      });
                    }
                    await fencedTools.write('approved.txt', 'lifecycle-output');
                    return { status: 'completed' };
                  }
                };
              }
            });
            if (lifecycle === 'restart') {
              const running = await resumedAuthority.startExecutionChild({
                ...childIdentity,
                expectedRevision: 2,
                sessionRef: { backend: 'pi', value: 'previous-worker-session' }
              });
              await expect(
                lifecycleRunner.run(scopeId, 'parent', { ...agentRequest, attempt: running })
              ).rejects.toThrow('independent session recovery');
              expect(stopConfirmation).not.toHaveBeenCalled();
            } else if (lifecycle === 'failure') {
              await expect(lifecycleRunner.run(scopeId, 'parent', agentRequest)).rejects.toThrow(
                'External session lost'
              );
              expect(stopConfirmation).not.toHaveBeenCalled();
            } else {
              const outcome = await lifecycleRunner.run(scopeId, 'parent', agentRequest);
              expect(outcome.claimState).toBe(
                lifecycle === 'success' ||
                  lifecycle === 'concurrent' ||
                  lifecycle.startsWith('repair-') ||
                  lifecycle.startsWith('integration-')
                  ? 'RELEASED'
                  : 'HELD_UNCERTAIN'
              );
            }
            const saved = await executionStore.recoverRun(request.run.id);
            expect(saved?.attempts[0]?.attempt).toMatchObject({
              state:
                lifecycle === 'failure' || lifecycle === 'restart'
                  ? 'UNKNOWN'
                  : lifecycle === 'cancel'
                    ? 'CANCELLED'
                    : 'COMPLETED',
              revision: lifecycle === 'restart' ? 4 : 5
            });
            const finalClaim = await admin.unsafe(
              `select state from "${schema}".forge_global_claims where claim_id=$1`,
              [child.claimId]
            );
            expect(finalClaim[0]?.state).toBe(
              lifecycle === 'success' ||
                lifecycle === 'concurrent' ||
                lifecycle.startsWith('repair-') ||
                lifecycle.startsWith('integration-')
                ? 'RELEASED'
                : 'HELD_UNCERTAIN'
            );
            await expect(attachTools(resumedAuthority)).rejects.toThrow();
            expect(readFileSync(join(worktree, 'after-cancel.txt'), 'utf8')).toBe('before');
            expect(
              await resumedAuthority.recoverFencedMutationPermits(scopeId, child.claimId)
            ).toHaveLength(lifecycle === 'inflight' ? 1 : 0);
            if (lifecycle.startsWith('integration-')) {
              const snapshots = new GitRepositorySnapshotProvider();
              const snapshot = await snapshots.capture({ repositoryPath: worktree });
              const evidencePayload = {
                id: 'integration-verification',
                runId: request.run.id,
                taskId: 'task',
                attemptId: agentRequest.attempt.id,
                workspaceId: workspace.id,
                workspaceRevision: workspace.revision,
                workspaceChangeFingerprint: snapshot.workingTreeFingerprint,
                verificationPolicyFingerprint: request.run.authority.verificationPolicyFingerprint,
                status: 'passed' as const,
                verifiedAt: new Date().toISOString()
              };
              const evidence = {
                ...evidencePayload,
                fingerprint: taskVerificationEvidenceFingerprint(evidencePayload)
              };
              await executionStore.persistVerificationEvidence(evidence);
              const subject = {
                builderAttemptId: agentRequest.attempt.id,
                outputAttemptId: agentRequest.attempt.id,
                workspaceId: workspace.id,
                workspaceRevision: workspace.revision,
                workspaceChangeFingerprint: snapshot.workingTreeFingerprint,
                impactFingerprint: `sha256:${'a'.repeat(64)}`,
                verificationFingerprint: evidence.fingerprint
              };
              await executionStore.persistReview({
                runId: request.run.id,
                taskId: 'task',
                iteration: 1,
                subject,
                review: {
                  recommendation: 'accept',
                  summary: 'Accepted exact integration output',
                  findings: []
                }
              });
              const integrationRequest = {
                scopeId,
                claimId: 'integration-global',
                owner: { ...parentOwner, attemptId: 'integration-execution' },
                reviewIteration: 1,
                subject
              };
              const counterBefore = await admin.unsafe(
                `select next_token from "${schema}".forge_global_scopes where id=$1`,
                [scopeId]
              );
              if (lifecycle === 'integration-denied' || lifecycle === 'integration-success') {
                const approvedBinding = request.taskBindings[0];
                const completedBuilder = (await executionStore.recoverRun(request.run.id))
                  ?.attempts[0]?.attempt;
                if (completedBuilder === undefined) {
                  throw new Error('Missing completed builder anchor');
                }
                const driftedPlan =
                  lifecycle === 'integration-denied'
                    ? {
                        ...approvedBinding.leasePlan,
                        predictedResources: [
                          ...approvedBinding.leasePlan.predictedResources,
                          { type: 'repository' as const }
                        ]
                      }
                    : { ...approvedBinding.leasePlan, source: 'runtime-derived' as const };
                await admin.unsafe(
                  `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='binding' and key=$2`,
                  [
                    request.run.id,
                    'task',
                    JSON.stringify({ ...approvedBinding, leasePlan: driftedPlan })
                  ]
                );
                // Also change the mutable builder record: only the committed handoff
                // digest can establish that this wider/different plan was never approved.
                await admin.unsafe(
                  `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='builder' and key=$2`,
                  [
                    request.run.id,
                    completedBuilder.id,
                    JSON.stringify({
                      ...completedBuilder,
                      leasePlanFingerprint: taskLeasePlanFingerprint(driftedPlan)
                    })
                  ]
                );
                await expect(
                  resumedAuthority.admitIntegrationExecution(integrationRequest)
                ).rejects.toThrow('committed execution plan');
                expect(
                  await admin.unsafe(
                    `select next_token from "${schema}".forge_global_scopes where id=$1`,
                    [scopeId]
                  )
                ).toEqual(counterBefore);
                expect(
                  await admin.unsafe(
                    `select 1 from "${schema}".forge_global_claims where claim_id='integration-global'`
                  )
                ).toHaveLength(0);
                expect(
                  await admin.unsafe(
                    `select 1 from "${schema}".forge_records where run_id=$1 and kind='integration-claim'`,
                    [request.run.id]
                  )
                ).toHaveLength(0);
                expect(
                  await admin.unsafe(
                    `select 1 from "${schema}".forge_global_leases where claim_id='integration-global'`
                  )
                ).toHaveLength(0);
                await admin.unsafe(
                  `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='binding' and key=$2`,
                  [request.run.id, 'task', JSON.stringify(approvedBinding)]
                );
                await admin.unsafe(
                  `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='builder' and key=$2`,
                  [request.run.id, completedBuilder.id, JSON.stringify(completedBuilder)]
                );
                if (lifecycle === 'integration-success') {
                  await admin.unsafe(
                    `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='builder' and key=$2`,
                    [
                      request.run.id,
                      completedBuilder.id,
                      JSON.stringify({
                        ...completedBuilder,
                        leasePlanFingerprint: taskLeasePlanFingerprint(driftedPlan)
                      })
                    ]
                  );
                  await expect(
                    resumedAuthority.admitIntegrationExecution(integrationRequest)
                  ).rejects.toThrow('builder execution plan');
                  expect(
                    await admin.unsafe(
                      `select next_token from "${schema}".forge_global_scopes where id=$1`,
                      [scopeId]
                    )
                  ).toEqual(counterBefore);
                  expect(
                    await admin.unsafe(
                      `select 1 from "${schema}".forge_records where run_id=$1 and kind='integration-claim'`,
                      [request.run.id]
                    )
                  ).toHaveLength(0);
                  await admin.unsafe(
                    `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='builder' and key=$2`,
                    [request.run.id, completedBuilder.id, JSON.stringify(completedBuilder)]
                  );
                }
              }
              if (lifecycle === 'integration-denied') {
                await expect(
                  resumedAuthority.admitIntegrationExecution(integrationRequest)
                ).rejects.toThrow('repository execution authority');
                expect(
                  await admin.unsafe(
                    `select next_token from "${schema}".forge_global_scopes where id=$1`,
                    [scopeId]
                  )
                ).toEqual(counterBefore);
                expect(git('rev-parse', 'HEAD')).toBe(base);
                return;
              }
              const admitted = await resumedAuthority.admitIntegrationExecution(integrationRequest);
              if (admitted.status !== 'granted') {
                throw new Error('Expected integration grant');
              }
              expect(await resumedAuthority.admitIntegrationExecution(integrationRequest)).toEqual(
                admitted
              );
              let gitCalls = 0;
              const manager = new GitWorkspaceManager();
              const integrationRunner = new PostgresIntegrationRunner({
                authority:
                  lifecycle === 'integration-persist-failure'
                    ? new Proxy(resumedAuthority, {
                        get(target, property) {
                          if (property === 'finishIntegrationExecution') {
                            return async () => {
                              throw new Error('Integration persistence unavailable');
                            };
                          }
                          const value = Reflect.get(target, property);
                          return typeof value === 'function' ? value.bind(target) : value;
                        }
                      })
                    : resumedAuthority,
                snapshots,
                ...(lifecycle === 'integration-unconfirmed'
                  ? {}
                  : { confirmStopped: async () => 'Independent Git supervisor confirmed exit' }),
                workspaceManager: {
                  commit: async (commitRequest) => {
                    gitCalls += 1;
                    await expect(integrationRunner.run(admitted.execution)).rejects.toThrow(
                      'already running'
                    );
                    if (lifecycle === 'integration-failure') {
                      throw new Error('Git process response lost');
                    }
                    if (lifecycle === 'integration-cancel') {
                      await executionStore.requestCancellation(request.run.id);
                    }
                    if (lifecycle === 'integration-trust') {
                      await admin.unsafe(
                        `update "${schema}".forge_global_trust_keys set state='REVOKED' where key_id='key'`
                      );
                    }
                    if (lifecycle === 'integration-inflight') {
                      await resumedAuthority.beginFencedMutation({
                        ...admitted.execution,
                        resource: { type: 'repository' }
                      });
                    }
                    return manager.commit(commitRequest);
                  },
                  integrate: async (target) => {
                    if (lifecycle === 'integration-blocked') {
                      writeFileSync(
                        join(integration, 'approved.txt'),
                        'Independent integration conflict'
                      );
                    }
                    return manager.integrate(target);
                  }
                }
              });
              if (lifecycle === 'integration-restart') {
                await resumedAuthority.startIntegrationExecution(
                  admitted.execution,
                  'previous-git-launch'
                );
                await expect(integrationRunner.run(admitted.execution)).rejects.toThrow(
                  'already running'
                );
                expect(gitCalls).toBe(0);
                const recoveredIntegration = await resumedAuthority.recoverIntegrationExecution(
                  scopeId,
                  request.run.id,
                  'task'
                );
                await expect(integrationRunner.run(recoveredIntegration)).rejects.toThrow(
                  'independent recovery'
                );
                expect(gitCalls).toBe(0);
                expect(
                  await admin.unsafe(
                    `select state from "${schema}".forge_global_claims where claim_id='integration-global'`
                  )
                ).toMatchObject([{ state: 'HELD_UNCERTAIN' }]);
                return;
              }
              if (lifecycle === 'integration-failure') {
                await expect(integrationRunner.run(admitted.execution)).rejects.toThrow(
                  'response lost'
                );
              } else if (lifecycle === 'integration-persist-failure') {
                await expect(integrationRunner.run(admitted.execution)).rejects.toThrow(
                  'persistence unavailable'
                );
                expect(
                  await resumedAuthority.recoverFencedMutationPermits(
                    scopeId,
                    admitted.execution.claimId
                  )
                ).toHaveLength(1);
                const held = (
                  await resumedAuthority.recoverRepositoryMutationAuthority(scopeId)
                ).find((lease) => lease.claimId === admitted.execution.claimId);
                if (held === undefined) {
                  throw new Error('Missing in-flight integration lease');
                }
                await expect(
                  resumedAuthority.releaseGlobalMutation({
                    ...admitted.execution,
                    expectedVersion: held.version,
                    stopEvidence: 'Cannot release an unresolved Git callback'
                  })
                ).rejects.toThrow();
                expect(
                  await admin.unsafe(
                    `select state from "${schema}".forge_global_claims where claim_id='integration-global'`
                  )
                ).toMatchObject([{ state: 'ACTIVE' }]);
                return;
              } else {
                expect(await integrationRunner.run(admitted.execution)).toBe(
                  lifecycle === 'integration-success' ? 'RELEASED' : 'HELD_UNCERTAIN'
                );
              }
              expect(gitCalls).toBe(1);
              expect(
                await resumedAuthority.recoverFencedMutationPermits(
                  scopeId,
                  admitted.execution.claimId
                )
              ).toHaveLength(lifecycle === 'integration-inflight' ? 1 : 0);
              expect(
                await admin.unsafe(
                  `select state from "${schema}".forge_global_claims where claim_id='integration-global'`
                )
              ).toMatchObject([
                { state: lifecycle === 'integration-success' ? 'RELEASED' : 'HELD_UNCERTAIN' }
              ]);
              if (lifecycle === 'integration-success') {
                expect(readFileSync(join(integration, 'approved.txt'), 'utf8')).toBe(
                  'lifecycle-output'
                );
                expect(
                  (await executionStore.recoverRun(request.run.id))?.workspaces[0]?.workspace.phase
                ).toBe('INTEGRATED');
              }
              return;
            }
            if (lifecycle.startsWith('repair-')) {
              const digest = `sha256:${'a'.repeat(64)}`;
              const repair = {
                id: 'global-repair',
                runId: request.run.id,
                taskId: agentRequest.taskId,
                agentId: 'repair-agent',
                workspaceId: workspace.id,
                parentReviewIteration: 1,
                repairIteration: 1,
                state: 'PREPARING' as const,
                revision: 1,
                parentReviewSubject: {
                  builderAttemptId: agentRequest.attempt.id,
                  outputAttemptId: agentRequest.attempt.id,
                  workspaceId: workspace.id,
                  workspaceRevision: workspace.revision,
                  workspaceChangeFingerprint: digest,
                  impactFingerprint: digest,
                  verificationFingerprint: digest
                }
              };
              await executionStore.persistRepairAttempt({ runId: repair.runId, attempt: repair });
              await executionStore.persistRepairWorkItem({
                runId: repair.runId,
                taskId: repair.taskId,
                repairAttemptId: repair.id,
                builderAttemptId: agentRequest.attempt.id,
                workspaceId: workspace.id,
                leasePlanFingerprint: taskLeasePlanFingerprint(request.taskBindings[0].leasePlan),
                impactFingerprint: digest,
                parentReviewIteration: 1,
                reviewIteration: 2,
                verificationPolicyFingerprint: digest,
                codeReviewPolicyFingerprint: digest
              });
              const repairOwner = {
                runId: repair.runId,
                taskId: repair.taskId,
                attemptId: repair.id,
                agentId: repair.agentId,
                workspaceId: repair.workspaceId
              };
              if (lifecycle === 'repair-success') {
                await admin.unsafe(
                  `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='repair' and key=$2`,
                  [
                    repair.runId,
                    repair.id,
                    JSON.stringify({
                      ...repair,
                      parentReviewSubject: {
                        ...repair.parentReviewSubject,
                        impactFingerprint: `sha256:${'b'.repeat(64)}`
                      }
                    })
                  ]
                );
                await expect(
                  resumedAuthority.claimGlobalMutation({
                    scopeId,
                    claimId: 'repair-claim',
                    owner: repairOwner,
                    resources: request.taskBindings[0].leasePlan.predictedResources
                  })
                ).rejects.toThrow('provenance');
                expect(
                  await admin.unsafe(
                    `select 1 from "${schema}".forge_global_claims where claim_id='repair-claim'`
                  )
                ).toHaveLength(0);
                await admin.unsafe(
                  `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='repair' and key=$2`,
                  [repair.runId, repair.id, JSON.stringify(repair)]
                );
                await executionStore.persistReview({
                  runId: repair.runId,
                  taskId: repair.taskId,
                  iteration: repair.parentReviewIteration,
                  subject: repair.parentReviewSubject,
                  review: {
                    recommendation: 'accept',
                    summary: 'Persisted subject fixture',
                    findings: []
                  }
                });
                await admin.unsafe(
                  `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='repair' and key=$2`,
                  [
                    repair.runId,
                    repair.id,
                    JSON.stringify({
                      ...repair,
                      parentReviewSubject: {
                        ...repair.parentReviewSubject,
                        outputAttemptId: 'wrong-review-output'
                      }
                    })
                  ]
                );
                await expect(
                  resumedAuthority.claimGlobalMutation({
                    scopeId,
                    claimId: 'repair-claim',
                    owner: repairOwner,
                    resources: request.taskBindings[0].leasePlan.predictedResources
                  })
                ).rejects.toThrow('persisted parent review');
                await admin.unsafe(
                  `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='repair' and key=$2`,
                  [repair.runId, repair.id, JSON.stringify(repair)]
                );
              }
              const grant = await resumedAuthority.claimGlobalMutation({
                scopeId,
                claimId: 'repair-claim',
                owner: repairOwner,
                resources: request.taskBindings[0].leasePlan.predictedResources
              });
              if (grant.status !== 'granted') {
                throw new Error('Repair did not acquire global ownership');
              }
              const repairIdentity = {
                scopeId,
                claimId: 'repair-claim',
                owner: repairOwner,
                token: grant.token
              };
              const admittedRepair = await resumedAuthority.recoverRepairExecution(repairIdentity);
              if (lifecycle === 'repair-success') {
                const snapshot = async () => ({
                  claims: await admin.unsafe(
                    `select * from "${schema}".forge_global_claims where claim_id='repair-claim'`
                  ),
                  counter: await admin.unsafe(
                    `select next_token from "${schema}".forge_global_scopes where id=$1`,
                    [scopeId]
                  ),
                  history: await admin.unsafe(
                    `select key,payload from "${schema}".forge_records where run_id=$1 and kind='repair-history' order by key`,
                    [repair.runId]
                  ),
                  permits: await resumedAuthority.recoverFencedMutationPermits(
                    scopeId,
                    'repair-claim'
                  )
                });
                const beforeTamper = await snapshot();
                for (const drift of [
                  { impactFingerprint: `sha256:${'b'.repeat(64)}` },
                  { outputAttemptId: 'different-output' },
                  { workspaceChangeFingerprint: `sha256:${'b'.repeat(64)}` },
                  { verificationFingerprint: `sha256:${'b'.repeat(64)}` }
                ]) {
                  const tampered = {
                    ...admittedRepair.attempt,
                    parentReviewSubject: { ...admittedRepair.attempt.parentReviewSubject, ...drift }
                  };
                  await admin.unsafe(
                    `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='repair' and key=$2`,
                    [repair.runId, repair.id, JSON.stringify(tampered)]
                  );
                  await expect(
                    resumedAuthority.recoverRepairExecution(repairIdentity)
                  ).rejects.toThrow('provenance');
                  await expect(
                    resumedAuthority.startRepairExecution({
                      ...repairIdentity,
                      expectedRevision: 2,
                      sessionRef: { backend: 'pi', value: 'tampered-session' }
                    })
                  ).rejects.toThrow('provenance');
                  await expect(
                    resumedAuthority.finishRepairExecution({
                      ...repairIdentity,
                      expectedRevision: 2,
                      state: 'UNKNOWN',
                      detail: 'Tampered outcome must not commit'
                    })
                  ).rejects.toThrow('provenance');
                  await expect(
                    resumedAuthority.beginFencedMutation({
                      ...repairIdentity,
                      resource: request.taskBindings[0].leasePlan.predictedResources[0]
                    })
                  ).rejects.toThrow('provenance');
                  await expect(
                    resumedAuthority.claimGlobalMutation({
                      ...repairIdentity,
                      resources: request.taskBindings[0].leasePlan.predictedResources
                    })
                  ).rejects.toThrow('provenance');
                  expect(await snapshot()).toEqual(beforeTamper);
                  expect(
                    await admin.unsafe(
                      `select payload from "${schema}".forge_records where run_id=$1 and kind='repair' and key=$2`,
                      [repair.runId, repair.id]
                    )
                  ).toMatchObject([{ payload: JSON.stringify(tampered) }]);
                }
                await admin.unsafe(
                  `update "${schema}".forge_records set payload=$3 where run_id=$1 and kind='repair' and key=$2`,
                  [repair.runId, repair.id, JSON.stringify(admittedRepair.attempt)]
                );
                expect(await resumedAuthority.recoverRepairExecution(repairIdentity)).toEqual(
                  admittedRepair
                );
              }
              const repairRequest = {
                ...agentRequest,
                attempt: {
                  ...agentRequest.attempt,
                  id: repair.id,
                  agentId: repair.agentId,
                  state:
                    admittedRepair.attempt.state === 'RUNNING'
                      ? ('RUNNING' as const)
                      : ('STARTING' as const),
                  revision: admittedRepair.attempt.revision,
                  leasePlanFingerprint: `repair:${digest}`
                }
              };
              await expect(
                resumedAuthority.recoverRepairExecution({
                  ...repairIdentity,
                  owner: { ...repairOwner, workspaceId: 'wrong-workspace' }
                })
              ).rejects.toThrow();
              let repairLaunches = 0;
              const repairRunner = new PostgresRepairRunner({
                authority: resumedAuthority,
                persistence: executionStore,
                resolveResource: () => ({ type: 'project', projectId: 'project' }),
                resolveFileId: (path) => path,
                ...(lifecycle === 'repair-unconfirmed'
                  ? {}
                  : { confirmStopped: async () => 'Independent repair supervisor confirmed exit' }),
                createRunner: (repairTools) => {
                  repairLaunches += 1;
                  return {
                    run: async (session) => {
                      expect(
                        (await executionStore.recoverRepairAttempts(repair.runId))[0]?.attempt
                      ).toMatchObject({
                        state: 'RUNNING',
                        revision: 3,
                        sessionRef: { backend: 'forge-repair-launch-reservation' }
                      });
                      await expect(
                        repairRunner.run(repairIdentity, repairRequest)
                      ).rejects.toThrow();
                      expect(repairLaunches).toBe(1);
                      await session.onStarted({
                        sessionRef: { backend: 'pi', value: 'repair-session' }
                      });
                      if (lifecycle === 'repair-failure') {
                        throw new Error('Repair session lost');
                      }
                      if (lifecycle === 'repair-cancel') {
                        await executionStore.requestCancellation(repair.runId);
                        await expect(
                          repairTools.write('after-cancel.txt', 'forbidden')
                        ).rejects.toThrow();
                        return {
                          status: 'cancelled',
                          detail: 'Repair session cancellation confirmed'
                        };
                      }
                      if (lifecycle === 'repair-inflight') {
                        await resumedAuthority.beginFencedMutation({
                          ...repairIdentity,
                          resource: { type: 'project', projectId: 'project' }
                        });
                      }
                      if (lifecycle === 'repair-trust') {
                        await admin.unsafe(
                          `update "${schema}".forge_global_trust_keys set state='REVOKED' where key_id='key'`
                        );
                        await expect(
                          repairTools.write('after-cancel.txt', 'forbidden')
                        ).rejects.toThrow('trust is no longer current');
                        return { status: 'completed' };
                      }
                      await expect(
                        repairTools.executeRepositoryMutation(async () => undefined)
                      ).rejects.toThrow();
                      await repairTools.write('approved.txt', 'repair-output');
                      return { status: 'completed' };
                    }
                  };
                }
              });
              if (lifecycle === 'repair-restart') {
                const runningRepair = await resumedAuthority.startRepairExecution({
                  ...repairIdentity,
                  expectedRevision: 2,
                  sessionRef: { backend: 'pi', value: 'old-repair-session' }
                });
                await expect(
                  repairRunner.run(repairIdentity, {
                    ...repairRequest,
                    attempt: {
                      ...repairRequest.attempt,
                      state: 'RUNNING',
                      revision: runningRepair.revision
                    }
                  })
                ).rejects.toThrow('independent session recovery');
                expect(repairLaunches).toBe(0);
              } else if (lifecycle === 'repair-failure') {
                await expect(repairRunner.run(repairIdentity, repairRequest)).rejects.toThrow(
                  'Repair session lost'
                );
              } else {
                expect((await repairRunner.run(repairIdentity, repairRequest)).claimState).toBe(
                  lifecycle === 'repair-success' ? 'RELEASED' : 'HELD_UNCERTAIN'
                );
              }
              const repairedAttempts = await executionStore.recoverRepairAttempts(repair.runId);
              expect(repairedAttempts[0]?.attempt).toMatchObject({
                state:
                  lifecycle === 'repair-restart' || lifecycle === 'repair-failure'
                    ? 'UNKNOWN'
                    : lifecycle === 'repair-cancel'
                      ? 'CANCELLED'
                      : 'COMPLETED',
                revision: lifecycle === 'repair-restart' ? 4 : 5,
                parentReviewSubject: repair.parentReviewSubject
              });
              const repairRows = await admin.unsafe(
                `select kind,payload from "${schema}".forge_records where run_id=$1 and kind='repair-history' order by key`,
                [repair.runId]
              );
              expect(repairRows.map((row) => JSON.parse(String(row.payload)).revision)).toEqual(
                lifecycle === 'repair-restart' ? [1, 2, 3] : [1, 2, 3, 4]
              );
              expect(
                await admin.unsafe(
                  `select state from "${schema}".forge_global_claims where claim_id='repair-claim'`
                )
              ).toMatchObject([
                { state: lifecycle === 'repair-success' ? 'RELEASED' : 'HELD_UNCERTAIN' }
              ]);
              expect(
                await resumedAuthority.recoverFencedMutationPermits(scopeId, 'repair-claim')
              ).toHaveLength(lifecycle === 'repair-inflight' ? 1 : 0);
              await expect(
                resumedAuthority.recoverRepairExecution(repairIdentity)
              ).rejects.toThrow();
              expect(readFileSync(join(worktree, 'after-cancel.txt'), 'utf8')).toBe('before');
            }
            return;
          }
          await store.requestCancellation(request.run.id);
          await expect(resumed.write('after-cancel.txt', 'forbidden')).rejects.toThrow();
          expect(readFileSync(join(worktree, 'after-cancel.txt'), 'utf8')).toBe('before');
          await expect(attachTools(resumedAuthority)).rejects.toThrow();
          expect((await store.recoverRun(request.run.id))?.run.state).toBe('CANCEL_REQUESTED');
          await admin.unsafe(`update "${schema}".forge_runs set state='ACTIVE' where id=$1`, [
            request.run.id
          ]);
          await admin.unsafe(
            `update "${schema}".forge_global_claims set state='HELD_UNCERTAIN',version=version+1 where claim_id=$1`,
            [child.claimId]
          );
          await expect(resumed.write('after-cancel.txt', 'forbidden')).rejects.toThrow();
          await expect(attachTools(resumedAuthority)).rejects.toThrow(
            'Execution child is not the active approved handoff claim'
          );
        } finally {
          await resumedAuthority.close();
        }
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
