import { createHash } from 'node:crypto';

import postgres from 'postgres';

import {
  assertPostgresEvidenceStoreConfiguration,
  type PostgresEvidenceStoreConfiguration
} from './postgres-evidence-store.js';

type Sql = ReturnType<typeof postgres>;
type TransactionSql = postgres.TransactionSql;

const migrations = [
  {
    version: 1,
    statements: [
      `create table {schema}.forge_runs (
        id text primary key, state text not null, payload text not null
      )`,
      `create table {schema}.forge_records (
        run_id text not null references {schema}.forge_runs(id),
        kind text not null, key text not null, payload text not null,
        primary key (run_id, kind, key)
      )`
    ]
  },
  {
    version: 2,
    statements: ['create index forge_records_kind_run_idx on {schema}.forge_records (kind, run_id)']
  },
  {
    version: 3,
    statements: [
      `create table {schema}.forge_global_control (
        id integer primary key check (id = 1), state text not null, next_token bigint not null
      )`,
      `insert into {schema}.forge_global_control (id,state,next_token)
        values (1,'LEGACY_ALLOWED',0)`,
      `create table {schema}.forge_global_scopes (
        id text primary key, state text not null
      )`,
      `create table {schema}.forge_global_aliases (
        repository_id text primary key, scope_id text not null
          references {schema}.forge_global_scopes(id)
      )`,
      `create table {schema}.forge_global_run_bindings (
        run_id text primary key references {schema}.forge_runs(id),
        repository_id text not null, scope_id text not null
          references {schema}.forge_global_scopes(id)
      )`,
      `create table {schema}.forge_global_claims (
        scope_id text not null references {schema}.forge_global_scopes(id),
        claim_id text not null, owner_json text not null, token bigint not null,
        state text not null, version bigint not null, evidence text,
        primary key (scope_id,claim_id)
      )`,
      `create table {schema}.forge_global_leases (
        scope_id text not null, claim_id text not null, lease_id text not null,
        resource_json text not null, primary key (scope_id,claim_id,lease_id),
        foreign key (scope_id,claim_id)
          references {schema}.forge_global_claims(scope_id,claim_id)
      )`,
      `create table {schema}.forge_global_permits (
        id text primary key, scope_id text not null, claim_id text not null,
        owner_json text not null, token bigint not null, resource_json text not null,
        verifier text not null,
        foreign key (scope_id,claim_id)
          references {schema}.forge_global_claims(scope_id,claim_id)
      )`,
      `create table {schema}.forge_global_legacy_owners (
        key text primary key, owner_json text not null, disposition text, evidence text
      )`,
      `create table {schema}.forge_global_audit (
        id text primary key, action text not null, subject text not null, evidence text not null
      )`
    ]
  },
  {
    version: 4,
    statements: [
      `alter table {schema}.forge_global_scopes add column next_token bigint`,
      `update {schema}.forge_global_scopes s set next_token = greatest(
        (select coalesce(max(c.token),0) from {schema}.forge_global_claims c where c.scope_id=s.id), 0
      )`,
      `alter table {schema}.forge_global_scopes alter column next_token set not null`,
      `alter table {schema}.forge_global_control drop column next_token`
    ]
  },
  {
    version: 5,
    statements: [
      `create table {schema}.forge_global_workspace_phases (
        scope_id text not null, parent_claim_id text not null,
        phase text not null check (phase in ('INITIAL_ADMITTED','WORKSPACE_ARMED','WORKSPACE_UNCERTAIN','HANDOFF_COMMITTED','ABANDONED')),
        primary key (scope_id,parent_claim_id),
        foreign key (scope_id,parent_claim_id)
          references {schema}.forge_global_claims(scope_id,claim_id)
      )`
    ]
  },
  {
    version: 6,
    statements: [
      `alter table {schema}.forge_global_workspace_phases add column setup_plan_digest text`,
      `alter table {schema}.forge_global_workspace_phases add column execution_plan_digest text`,
      `alter table {schema}.forge_global_workspace_phases add column execution_generation text`,
      `alter table {schema}.forge_global_workspace_phases add column workspace_id text`
    ]
  },
  {
    version: 7,
    statements: [
      `create table {schema}.forge_global_trust_registry (
        id integer primary key check (id = 1), revision bigint not null,
        policy_version text not null
      )`,
      `insert into {schema}.forge_global_trust_registry (id,revision,policy_version)
        values (1,0,'UNCONFIGURED')`,
      `create table {schema}.forge_global_trust_keys (
        key_id text primary key, public_key text not null,
        state text not null check (state in ('ACTIVE','RETIRED','REVOKED'))
      )`,
      `create table {schema}.forge_global_trust_revocations (
        kind text not null check (kind in ('DECISION','AUTHORIZATION')),
        digest text not null, registry_revision bigint not null,
        primary key (kind,digest)
      )`,
      `create table {schema}.forge_global_generations (
        id text primary key, scope_id text not null references {schema}.forge_global_scopes(id),
        parent_claim_id text not null, run_id text not null, task_id text not null,
        attempt_id text not null, workspace_id text not null, supervisor_id text not null,
        setup_plan_digest text not null, execution_plan_digest text not null,
        state text not null check (state in ('ISSUED','REVOKED')),
        foreign key (scope_id,parent_claim_id)
          references {schema}.forge_global_claims(scope_id,claim_id)
      )`
    ]
  },
  {
    version: 8,
    statements: [
      `create function {schema}.forge_trust_write(action text, identity text, detail text)
       returns bigint language plpgsql security definer set search_path = pg_catalog as $$
       declare current_revision bigint; existing record; next_revision bigint;
       begin
         perform pg_advisory_xact_lock(hashtext('forge-trust:{schema}'));
         select revision into current_revision from {schema}.forge_global_trust_registry where id=1 for update;
         if not found or current_revision = 9223372036854775807 then
           raise exception 'Missing or exhausted trust registry';
         end if;
         if identity is null or identity = '' or detail is null or detail = '' then
           raise exception 'Trust writer identity and detail are required';
         end if;
         if action = 'REGISTER_KEY' then
           select public_key,state into existing from {schema}.forge_global_trust_keys where key_id=identity;
            if found then
              if existing.public_key <> detail or existing.state <> 'ACTIVE' then
                raise exception 'Trust key identity cannot be replaced or reactivated';
              end if;
             return current_revision;
           end if;
           insert into {schema}.forge_global_trust_keys (key_id,public_key,state)
             values (identity,detail,'ACTIVE');
         elsif action = 'RETIRE_KEY' or action = 'REVOKE_KEY' then
            select public_key,state into existing from {schema}.forge_global_trust_keys where key_id=identity;
            if not found then raise exception 'Unknown trust key'; end if;
            if detail <> existing.public_key then raise exception 'Trust key identity cannot be replaced'; end if;
            if existing.state = 'REVOKED' or (existing.state = 'RETIRED' and action = 'RETIRE_KEY') then
              return current_revision;
            end if;
           update {schema}.forge_global_trust_keys
             set state = case when action='RETIRE_KEY' then 'RETIRED' else 'REVOKED' end
             where key_id=identity;
         elsif action = 'REVOKE_DECISION' or action = 'REVOKE_AUTHORIZATION' then
           if identity !~ '^[0-9a-f]{64}$' or detail <> identity then
             raise exception 'Exact trust revocation digest is required';
           end if;
           if exists (select 1 from {schema}.forge_global_trust_revocations
             where kind=case when action='REVOKE_DECISION' then 'DECISION' else 'AUTHORIZATION' end
               and digest=identity) then return current_revision; end if;
           insert into {schema}.forge_global_trust_revocations (kind,digest,registry_revision)
             values (case when action='REVOKE_DECISION' then 'DECISION' else 'AUTHORIZATION' end,
               identity,current_revision+1);
         elsif action = 'SET_POLICY' then
           if identity <> 'policy' then raise exception 'Invalid policy identity'; end if;
           if (select policy_version from {schema}.forge_global_trust_registry where id=1) = detail then
             return current_revision;
           end if;
         else
           raise exception 'Unsupported trust writer operation';
         end if;
         next_revision := current_revision + 1;
         update {schema}.forge_global_trust_registry
           set revision=next_revision,
               policy_version=case when action='SET_POLICY' then detail else policy_version end
           where id=1;
         return next_revision;
       end $$`,
      `revoke all on function {schema}.forge_trust_write(text,text,text) from public`,
      `create function {schema}.forge_generation_write(action text, generation_id text,
         target_scope text, parent_id text, run_identity text, task_identity text,
         attempt_identity text, workspace_identity text, supervisor_identity text,
         setup_digest text, execution_digest text)
       returns text language plpgsql security definer set search_path = pg_catalog as $$
       declare prior record; claim_owner jsonb; phase record;
       begin
         if generation_id is null or generation_id = '' or target_scope is null or target_scope = '' then
           raise exception 'Generation and scope identities are required';
         end if;
         if action <> 'ISSUE' and action <> 'REVOKE' then
           raise exception 'Unsupported generation operation';
         end if;
         perform pg_advisory_xact_lock_shared(hashtext('forge-trust:{schema}'));
         if not exists (select 1 from {schema}.forge_global_scopes
           where id=target_scope for update) then
           raise exception 'Unknown generation scope';
         end if;
         select * into prior from {schema}.forge_global_generations where id=generation_id;
         if action='REVOKE' then
           if not found or prior.scope_id <> target_scope then raise exception 'Unknown generation'; end if;
           if prior.state='REVOKED' then return 'REVOKED'; end if;
           update {schema}.forge_global_generations set state='REVOKED' where id=generation_id;
           return 'REVOKED';
         end if;
         if not exists (select 1 from {schema}.forge_global_scopes
           where id=target_scope and state='ACTIVE_FOR_GLOBAL_CLAIMS') then
           raise exception 'Inactive generation scope';
         end if;
         if parent_id is null or parent_id = '' or run_identity is null or run_identity = ''
           or task_identity is null or task_identity = '' or attempt_identity is null or attempt_identity = ''
           or workspace_identity is null or workspace_identity = ''
           or supervisor_identity is null or supervisor_identity = ''
           or setup_digest !~ '^[0-9a-f]{64}$' or execution_digest !~ '^[0-9a-f]{64}$' then
           raise exception 'Incomplete generation binding';
         end if;
         if found then
           if prior.state <> 'ISSUED' or prior.scope_id <> target_scope
             or prior.parent_claim_id <> parent_id or prior.run_id <> run_identity
             or prior.task_id <> task_identity or prior.attempt_id <> attempt_identity
             or prior.workspace_id <> workspace_identity or prior.supervisor_id <> supervisor_identity
             or prior.setup_plan_digest <> setup_digest or prior.execution_plan_digest <> execution_digest then
             raise exception 'Generation identity cannot be replaced or reactivated';
           end if;
           return 'ISSUED';
         end if;
         select owner_json::jsonb into claim_owner from {schema}.forge_global_claims
           where scope_id=target_scope and claim_id=parent_id and state='ACTIVE';
         if not found or claim_owner->>'runId' is distinct from run_identity
           or claim_owner->>'taskId' is distinct from task_identity
           or claim_owner->>'attemptId' is distinct from attempt_identity
           or claim_owner->>'workspaceId' is distinct from workspace_identity then
           raise exception 'Generation parent claim mismatch';
         end if;
         if not exists (select 1 from {schema}.forge_global_run_bindings b
           join {schema}.forge_runs r on r.id=b.run_id
           where b.run_id=run_identity and b.scope_id=target_scope and r.state='ACTIVE' for update of r) then
           raise exception 'Generation run is not active and bound';
         end if;
         select * into phase from {schema}.forge_global_workspace_phases
           where scope_id=target_scope and parent_claim_id=parent_id;
         if not found or phase.phase is distinct from 'INITIAL_ADMITTED'
           or phase.workspace_id is distinct from workspace_identity
           or phase.setup_plan_digest is distinct from setup_digest
           or phase.execution_plan_digest is distinct from execution_digest then
           raise exception 'Generation setup phase mismatch';
         end if;
         if phase.execution_generation is not null and phase.execution_generation <> generation_id then
           raise exception 'Generation setup phase already names another generation';
         end if;
          if exists (select 1 from {schema}.forge_global_generations
            where scope_id=target_scope
              and run_id=run_identity and task_id=task_identity and attempt_id=attempt_identity
              and workspace_id=workspace_identity and state='ISSUED') then
           raise exception 'A competing execution generation is already live';
         end if;
         insert into {schema}.forge_global_generations
           (id,scope_id,parent_claim_id,run_id,task_id,attempt_id,workspace_id,
            supervisor_id,setup_plan_digest,execution_plan_digest,state)
           values (generation_id,target_scope,parent_id,run_identity,task_identity,
             attempt_identity,workspace_identity,supervisor_identity,setup_digest,execution_digest,'ISSUED');
         update {schema}.forge_global_workspace_phases set execution_generation=generation_id
           where scope_id=target_scope and parent_claim_id=parent_id;
         return 'ISSUED';
       end $$`,
      `revoke all on function {schema}.forge_generation_write(text,text,text,text,text,text,text,text,text,text,text) from public`
    ]
  },
  {
    version: 9,
    statements: [
      `alter table {schema}.forge_global_workspace_phases add column signing_key text`,
      `alter table {schema}.forge_global_workspace_phases add column authorization_digest text`,
      `create function {schema}.forge_setup_admit(target_scope text, parent_id text,
          run_identity text, task_identity text, attempt_identity text, agent_identity text,
           workspace_identity text, repository_identity text, artifact_identity text,
            execution_approval_identity text, execution_fingerprint text, plan_fingerprint text,
           setup_digest text, authorization_digest text, signing_key text,
           execution_plan_digest text, artifact_revision text, repository_root text,
           base_commit text, signing_public_key text, attempt_fingerprint text)
        returns text language plpgsql security definer set search_path = pg_catalog as $$
        declare control_state text; scope record; registered_key record;
          run_row record; binding record; task_payload jsonb; attempt_payload jsonb;
          existing_claim record; token_value bigint; conflicting boolean;
        begin
          perform pg_advisory_xact_lock_shared(hashtext('forge-trust:{schema}'));
          if not exists (select 1 from {schema}.forge_global_trust_registry
            where id=1 and policy_version='git-workspace-setup-v1') then
            raise exception 'Workspace setup trust policy is not active';
          end if;
           select state,public_key into registered_key from {schema}.forge_global_trust_keys where key_id=signing_key;
           if not found or registered_key.state <> 'ACTIVE'
             or registered_key.public_key is distinct from signing_public_key
            or setup_digest !~ '^[0-9a-f]{64}$' or authorization_digest !~ '^[0-9a-f]{64}$'
            or execution_plan_digest !~ '^[0-9a-f]{64}$'
            or exists (select 1 from {schema}.forge_global_trust_revocations
              where (kind='DECISION' and digest=setup_digest)
                or (kind='AUTHORIZATION' and digest=authorization_digest)) then
            raise exception 'Workspace setup trust is not current';
          end if;
          select state into control_state from {schema}.forge_global_control where id=1;
          if control_state is distinct from 'GLOBAL_READY' then
            raise exception 'Global mutation authority is not ready';
          end if;
          select state,next_token into scope from {schema}.forge_global_scopes
            where id=target_scope for update;
          if not found or scope.state <> 'ACTIVE_FOR_GLOBAL_CLAIMS' then
            raise exception 'Workspace setup scope is not active';
          end if;
          select state,payload into run_row from {schema}.forge_runs
            where id=run_identity for update;
          if not found or run_row.state <> 'ACTIVE' then
            raise exception 'Workspace setup run is not active';
          end if;
          if not exists (select 1 from {schema}.forge_global_run_bindings b
            join {schema}.forge_global_aliases a on a.repository_id=b.repository_id
            where b.run_id=run_identity and b.scope_id=target_scope
              and a.scope_id=target_scope and b.repository_id=repository_identity)
            or run_row.payload::jsonb->'run'->>'id' is distinct from run_identity
            or run_row.payload::jsonb->'run'->>'repositoryId' is distinct from repository_identity
             or run_row.payload::jsonb->'run'->'authority'->>'artifactId' is distinct from artifact_identity
             or run_row.payload::jsonb->'run'->'authority'->>'artifactRevision' is distinct from artifact_revision
             or run_row.payload::jsonb->'run'->'authority'->>'approvalId' is distinct from execution_approval_identity
              or run_row.payload::jsonb->'run'->'authority'->>'approvalFingerprint' is distinct from execution_fingerprint
              or run_row.payload::jsonb->'run'->'authority'->>'planFingerprint' is distinct from plan_fingerprint
             or run_row.payload::jsonb->'run'->'authority'->>'repositoryRoot' is distinct from repository_root
             or run_row.payload::jsonb->'run'->'authority'->>'baseCommit' is distinct from base_commit
            or not exists (select 1 from jsonb_array_elements(run_row.payload::jsonb->'tasks') t
              where t->>'id'=task_identity) then
            raise exception 'Workspace setup does not match persisted run approval';
          end if;
          select payload::jsonb into task_payload from {schema}.forge_records
            where run_id=run_identity and kind='binding' and key=task_identity;
          select payload::jsonb into attempt_payload from {schema}.forge_records
            where run_id=run_identity and kind='builder' and key=attempt_identity;
           if task_payload is null or attempt_payload is null
            or task_payload->>'runId' is distinct from run_identity
            or task_payload->>'taskId' is distinct from task_identity
            or task_payload->>'agentId' is distinct from agent_identity
             or task_payload->'workspace'->>'id' is distinct from workspace_identity
             or task_payload->'workspace'->>'integrationRepositoryPath' is distinct from repository_root
             or task_payload->'workspace'->>'baseRef' is null
             or task_payload->'leasePlan'->>'taskId' is distinct from task_identity
             or task_payload->'leasePlan'->'predictedResources' is null
             or attempt_payload->>'revision' is null
            or attempt_payload->>'id' is distinct from attempt_identity
            or attempt_payload->>'taskId' is distinct from task_identity
            or attempt_payload->>'runId' is distinct from run_identity
            or attempt_payload->>'agentId' is distinct from agent_identity
            or attempt_payload->>'workspaceId' is distinct from workspace_identity
              or attempt_payload->>'leasePlanFingerprint' is distinct from attempt_fingerprint
            or attempt_payload->>'state' not in ('PREPARING','STARTING') then
            raise exception 'Workspace setup attempt or binding is incompatible';
          end if;
           select * into existing_claim from {schema}.forge_global_claims
            where scope_id=target_scope and claim_id=parent_id;
          if found then
            if attempt_payload->>'state'='STARTING'
               and existing_claim.state='ACTIVE' and existing_claim.owner_json::jsonb=
              jsonb_build_object('runId',run_identity,'taskId',task_identity,
                'attemptId',attempt_identity,'agentId',agent_identity,'workspaceId',workspace_identity)
              and exists (select 1 from {schema}.forge_global_workspace_phases
                where scope_id=target_scope and parent_claim_id=parent_id
                  and phase='INITIAL_ADMITTED' and workspace_id=workspace_identity
                   and setup_plan_digest=setup_digest and forge_global_workspace_phases.execution_plan_digest=forge_setup_admit.execution_plan_digest
                   and forge_global_workspace_phases.signing_key=forge_setup_admit.signing_key
                   and forge_global_workspace_phases.authorization_digest=forge_setup_admit.authorization_digest)
               and existing_claim.token > 0 and existing_claim.token <= 9007199254740991
               and (select count(*) from {schema}.forge_global_leases
                where scope_id=target_scope and claim_id=parent_id)=1
              and exists (select 1 from {schema}.forge_global_leases
                where scope_id=target_scope and claim_id=parent_id
                   and resource_json::jsonb='{"type":"repository"}'::jsonb)
                then return 'GRANTED:' || existing_claim.token::text; end if;
            raise exception 'Workspace setup parent identity already exists';
          end if;
          if attempt_payload->>'state' <> 'PREPARING' then
            raise exception 'Only a preparing attempt may receive a new setup parent';
          end if;
          select exists (select 1 from {schema}.forge_global_claims c
            where c.scope_id=target_scope and c.state<>'RELEASED') into conflicting;
          if conflicting then
            return 'BLOCKED';
          end if;
           if scope.next_token >= 9007199254740991 then
             raise exception 'Workspace setup token exhausted';
           end if;
           token_value := scope.next_token+1;
          if token_value > 9007199254740991 or token_value <= 0 then
            raise exception 'Workspace setup token exhausted';
          end if;
          update {schema}.forge_global_scopes set next_token=token_value where id=target_scope;
          insert into {schema}.forge_global_claims
            (scope_id,claim_id,owner_json,token,state,version)
            values (target_scope,parent_id,jsonb_build_object('runId',run_identity,
              'taskId',task_identity,'attemptId',attempt_identity,'agentId',agent_identity,
              'workspaceId',workspace_identity)::text,token_value,'ACTIVE',1);
          insert into {schema}.forge_global_leases(scope_id,claim_id,lease_id,resource_json)
            values (target_scope,parent_id,gen_random_uuid()::text,'{"type":"repository"}');
          insert into {schema}.forge_global_workspace_phases
            (scope_id,parent_claim_id,phase,setup_plan_digest,execution_plan_digest,workspace_id,
              signing_key,authorization_digest)
            values (target_scope,parent_id,'INITIAL_ADMITTED',setup_digest,
              execution_plan_digest,workspace_identity,signing_key,authorization_digest);
          update {schema}.forge_records set payload=jsonb_set(
            jsonb_set(attempt_payload,'{state}','"STARTING"'::jsonb),
            '{revision}',to_jsonb((attempt_payload->>'revision')::integer+1))::text
            where run_id=run_identity and kind='builder' and key=attempt_identity;
           return 'GRANTED:' || token_value::text;
        end $$`,
      `revoke all on function {schema}.forge_setup_admit(${Array(21).fill('text').join(',')}) from public`
    ]
  },
  {
    version: 10,
    statements: [
      `create function {schema}.forge_setup_arm(target_scope text, parent_id text,
          run_identity text, task_identity text, attempt_identity text, agent_identity text,
          workspace_identity text, generation_identity text, setup_digest text,
          execution_digest text, signing_identity text, authorization_identity text,
          signing_public_key text, artifact_identity text, artifact_revision text,
          execution_approval_identity text, execution_fingerprint text,
          plan_fingerprint text, repository_identity text, repository_root text,
          base_commit text, attempt_fingerprint text)
        returns text language plpgsql security definer set search_path = pg_catalog as $$
        declare phase_row record; parent_row record; generation_row record;
          run_row record; binding_row jsonb;
        begin
          perform pg_advisory_xact_lock_shared(hashtext('forge-trust:{schema}'));
          if not exists (select 1 from {schema}.forge_global_trust_registry
            where id=1 and policy_version='git-workspace-setup-v1')
            or not exists (select 1 from {schema}.forge_global_trust_keys
              where key_id=signing_identity and state='ACTIVE'
                and public_key=signing_public_key)
            or exists (select 1 from {schema}.forge_global_trust_revocations
              where (kind='DECISION' and digest=setup_digest)
                 or (kind='AUTHORIZATION' and digest=authorization_identity)) then
            raise exception 'Workspace setup trust is not current';
          end if;
          if not exists (select 1 from {schema}.forge_global_control
            where id=1 and state='GLOBAL_READY') then
            raise exception 'Global mutation authority is not ready';
          end if;
          if not exists (select 1 from {schema}.forge_global_scopes
            where id=target_scope and state='ACTIVE_FOR_GLOBAL_CLAIMS' for update) then
            raise exception 'Workspace setup scope is not active';
          end if;
          select state,payload into run_row from {schema}.forge_runs
            where id=run_identity for update;
          if not found or run_row.state <> 'ACTIVE'
            or run_row.payload::jsonb->'run'->>'id' is distinct from run_identity
            or run_row.payload::jsonb->'run'->>'repositoryId' is distinct from repository_identity
            or run_row.payload::jsonb->'run'->'authority'->>'artifactId' is distinct from artifact_identity
            or run_row.payload::jsonb->'run'->'authority'->>'artifactRevision' is distinct from artifact_revision
            or run_row.payload::jsonb->'run'->'authority'->>'approvalId' is distinct from execution_approval_identity
            or run_row.payload::jsonb->'run'->'authority'->>'approvalFingerprint' is distinct from execution_fingerprint
            or run_row.payload::jsonb->'run'->'authority'->>'planFingerprint' is distinct from plan_fingerprint
            or run_row.payload::jsonb->'run'->'authority'->>'repositoryRoot' is distinct from repository_root
            or run_row.payload::jsonb->'run'->'authority'->>'baseCommit' is distinct from base_commit
            or not exists (select 1 from {schema}.forge_global_run_bindings b
              join {schema}.forge_global_aliases a on a.repository_id=b.repository_id
              where b.run_id=run_identity and b.scope_id=target_scope
                and a.scope_id=target_scope and a.repository_id=repository_identity) then
            raise exception 'Workspace setup run is not active and bound';
          end if;
          select owner_json::jsonb as owner, token, state into parent_row
            from {schema}.forge_global_claims
            where scope_id=target_scope and claim_id=parent_id;
          select * into phase_row from {schema}.forge_global_workspace_phases
            where scope_id=target_scope and parent_claim_id=parent_id;
          if parent_row.state is distinct from 'ACTIVE'
            or parent_row.owner is distinct from jsonb_build_object('runId',run_identity,
              'taskId',task_identity,'attemptId',attempt_identity,'agentId',agent_identity,
              'workspaceId',workspace_identity)
            or phase_row.phase not in ('INITIAL_ADMITTED','WORKSPACE_ARMED')
            or phase_row.workspace_id is distinct from workspace_identity
            or phase_row.setup_plan_digest is distinct from setup_digest
            or phase_row.execution_plan_digest is distinct from execution_digest
            or phase_row.signing_key is distinct from signing_identity
            or phase_row.authorization_digest is distinct from authorization_identity
            or phase_row.execution_generation is distinct from generation_identity
            or (select count(*) from {schema}.forge_global_leases
              where scope_id=target_scope and claim_id=parent_id) <> 1
            or not exists (select 1 from {schema}.forge_global_leases
              where scope_id=target_scope and claim_id=parent_id
                and resource_json::jsonb='{"type":"repository"}'::jsonb) then
            raise exception 'Workspace setup parent or phase is incompatible';
          end if;
          select * into generation_row from {schema}.forge_global_generations
            where id=generation_identity;
          if not found or generation_row.state <> 'ISSUED'
            or generation_row.scope_id <> target_scope
            or generation_row.parent_claim_id <> parent_id
            or generation_row.run_id <> run_identity
            or generation_row.task_id <> task_identity
            or generation_row.attempt_id <> attempt_identity
            or generation_row.workspace_id <> workspace_identity
            or generation_row.setup_plan_digest <> setup_digest
            or generation_row.execution_plan_digest <> execution_digest then
            raise exception 'Workspace setup execution generation is not current';
          end if;
          select payload::jsonb into binding_row from {schema}.forge_records
            where run_id=run_identity and kind='binding' and key=task_identity;
          if binding_row is null or binding_row->>'runId' is distinct from run_identity
            or binding_row->>'taskId' is distinct from task_identity
            or binding_row->>'agentId' is distinct from agent_identity
            or binding_row->'workspace'->>'id' is distinct from workspace_identity
            or binding_row->'workspace'->>'integrationRepositoryPath' is distinct from
              run_row.payload::jsonb->'run'->'authority'->>'repositoryRoot'
            or not exists (select 1 from jsonb_array_elements(run_row.payload::jsonb->'tasks') t
              where t->>'id'=task_identity)
            or not exists (select 1 from {schema}.forge_records
              where run_id=run_identity and kind='builder' and key=attempt_identity
                and payload::jsonb->>'state'='STARTING'
                and payload::jsonb->>'runId'=run_identity
                and payload::jsonb->>'taskId'=task_identity
                and payload::jsonb->>'workspaceId'=workspace_identity
                and payload::jsonb->>'agentId'=agent_identity
                and payload::jsonb->>'leasePlanFingerprint'=attempt_fingerprint) then
            raise exception 'Workspace setup attempt or approved workspace is incompatible';
          end if;
          if phase_row.phase='WORKSPACE_ARMED' then return 'ARMED'; end if;
          update {schema}.forge_global_workspace_phases set phase='WORKSPACE_ARMED'
            where scope_id=target_scope and parent_claim_id=parent_id;
          return 'ARMED';
        end $$`,
      `revoke all on function {schema}.forge_setup_arm(${Array(22).fill('text').join(',')}) from public`
    ]
  },
  {
    version: 11,
    statements: [
      `create table {schema}.forge_global_workspace_permit_lineages (
        scope_id text not null, parent_claim_id text not null,
        permit_id text not null unique, owner_json text not null,
        token bigint not null, generation_id text not null,
        workspace_id text not null, verifier text not null, completed boolean not null,
        primary key (scope_id,parent_claim_id),
        foreign key (scope_id,parent_claim_id)
          references {schema}.forge_global_claims(scope_id,claim_id)
      )`,
      `create function {schema}.forge_workspace_permit_begin(target_scope text, parent_id text,
          run_identity text, task_identity text, attempt_identity text, agent_identity text,
          workspace_identity text, generation_identity text, supervisor_identity text,
          parent_token text, parent_version text, completion_verifier text,
          setup_digest text, execution_digest text, signing_identity text,
          authorization_identity text, signing_public_key text, artifact_identity text,
          artifact_revision text, execution_approval_identity text, execution_fingerprint text,
          plan_fingerprint text, repository_identity text, repository_root text,
          base_commit text, attempt_fingerprint text)
        returns text language plpgsql security definer set search_path = pg_catalog as $$
        declare parent_row record; phase_row record; generation_row record; run_row record;
          permit_identity text;
        begin
          if completion_verifier !~ '^[0-9a-f]{64}$' then
            raise exception 'Invalid workspace completion verifier';
          end if;
          perform pg_advisory_xact_lock_shared(hashtext('forge-trust:{schema}'));
          if not exists (select 1 from {schema}.forge_global_trust_registry
            where id=1 and policy_version='git-workspace-setup-v1')
            or not exists (select 1 from {schema}.forge_global_trust_keys
              where key_id=signing_identity and state='ACTIVE'
                and public_key=signing_public_key)
            or exists (select 1 from {schema}.forge_global_trust_revocations
              where (kind='DECISION' and digest=setup_digest)
                 or (kind='AUTHORIZATION' and digest=authorization_identity))
            or not exists (select 1 from {schema}.forge_global_control
              where id=1 and state='GLOBAL_READY') then
            raise exception 'Workspace Git authority is not ready';
          end if;
          if not exists (select 1 from {schema}.forge_global_scopes
            where id=target_scope and state='ACTIVE_FOR_GLOBAL_CLAIMS' for update) then
            raise exception 'Workspace Git scope is not active';
          end if;
          select state,payload into run_row from {schema}.forge_runs
            where id=run_identity for update;
          if not found or run_row.state <> 'ACTIVE'
            or run_row.payload::jsonb->'run'->>'id' is distinct from run_identity
            or run_row.payload::jsonb->'run'->>'repositoryId' is distinct from repository_identity
            or run_row.payload::jsonb->'run'->'authority'->>'artifactId' is distinct from artifact_identity
            or run_row.payload::jsonb->'run'->'authority'->>'artifactRevision' is distinct from artifact_revision
            or run_row.payload::jsonb->'run'->'authority'->>'approvalId' is distinct from execution_approval_identity
            or run_row.payload::jsonb->'run'->'authority'->>'approvalFingerprint' is distinct from execution_fingerprint
            or run_row.payload::jsonb->'run'->'authority'->>'planFingerprint' is distinct from plan_fingerprint
            or run_row.payload::jsonb->'run'->'authority'->>'repositoryRoot' is distinct from repository_root
            or run_row.payload::jsonb->'run'->'authority'->>'baseCommit' is distinct from base_commit
            or not exists (select 1 from {schema}.forge_global_run_bindings b
              join {schema}.forge_global_aliases a on a.repository_id=b.repository_id
              where b.run_id=run_identity and b.scope_id=target_scope
                and a.scope_id=target_scope and a.repository_id=b.repository_id
                and b.repository_id=repository_identity) then
            raise exception 'Workspace Git run is not active and bound';
          end if;
          select * into phase_row from {schema}.forge_global_workspace_phases
            where scope_id=target_scope and parent_claim_id=parent_id;
          select * into parent_row from {schema}.forge_global_claims
            where scope_id=target_scope and claim_id=parent_id;
          if phase_row.phase is distinct from 'WORKSPACE_ARMED'
            or phase_row.workspace_id is distinct from workspace_identity
            or phase_row.execution_generation is distinct from generation_identity
            or phase_row.setup_plan_digest is distinct from setup_digest
            or phase_row.execution_plan_digest is distinct from execution_digest
            or phase_row.signing_key is distinct from signing_identity
            or phase_row.authorization_digest is distinct from authorization_identity
            or parent_row.state is distinct from 'ACTIVE'
            or parent_row.token::text is distinct from parent_token
            or parent_row.version::text is distinct from parent_version
            or parent_row.owner_json::jsonb is distinct from jsonb_build_object(
              'runId',run_identity,'taskId',task_identity,'attemptId',attempt_identity,
              'agentId',agent_identity,'workspaceId',workspace_identity)
            or (select count(*) from {schema}.forge_global_leases
              where scope_id=target_scope and claim_id=parent_id) <> 1
            or not exists (select 1 from {schema}.forge_global_leases
              where scope_id=target_scope and claim_id=parent_id
                and resource_json::jsonb='{"type":"repository"}'::jsonb) then
            raise exception 'Workspace Git parent is not armed';
          end if;
          select * into generation_row from {schema}.forge_global_generations
            where id=generation_identity;
          if not found or generation_row.state <> 'ISSUED'
            or generation_row.scope_id <> target_scope
            or generation_row.parent_claim_id <> parent_id
            or generation_row.run_id <> run_identity
            or generation_row.task_id <> task_identity
            or generation_row.attempt_id <> attempt_identity
            or generation_row.workspace_id <> workspace_identity
            or generation_row.supervisor_id <> supervisor_identity
            or generation_row.setup_plan_digest is distinct from setup_digest
            or generation_row.execution_plan_digest is distinct from execution_digest
            or not exists (select 1 from {schema}.forge_records
              where run_id=run_identity and kind='binding' and key=task_identity
                and payload::jsonb->>'agentId'=agent_identity
                and payload::jsonb->'workspace'->>'id'=workspace_identity
                and payload::jsonb->'workspace'->>'integrationRepositoryPath'=repository_root)
            or not exists (select 1 from {schema}.forge_records
              where run_id=run_identity and kind='builder' and key=attempt_identity
                and payload::jsonb->>'state'='STARTING'
                and payload::jsonb->>'runId'=run_identity
                and payload::jsonb->>'taskId'=task_identity
                and payload::jsonb->>'agentId'=agent_identity
                and payload::jsonb->>'workspaceId'=workspace_identity
                and payload::jsonb->>'leasePlanFingerprint'=attempt_fingerprint) then
            raise exception 'Workspace Git execution generation is not current';
          end if;
          if exists (select 1 from {schema}.forge_global_workspace_permit_lineages
            where scope_id=target_scope and parent_claim_id=parent_id) then
            raise exception 'Workspace Git permit lineage already exists';
          end if;
          permit_identity := gen_random_uuid()::text;
          insert into {schema}.forge_global_workspace_permit_lineages
            (scope_id,parent_claim_id,permit_id,owner_json,token,generation_id,workspace_id,verifier,completed)
            values (target_scope,parent_id,permit_identity,parent_row.owner_json,parent_row.token,
              generation_identity,workspace_identity,completion_verifier,false);
          return permit_identity;
        end $$`,
      `revoke all on function {schema}.forge_workspace_permit_begin(${Array(26).fill('text').join(',')}) from public`,
      `create function {schema}.forge_workspace_permit_finish(permit_identity text,
          completion_secret text, uncertainty_evidence text)
        returns text language plpgsql security definer set search_path = pg_catalog as $$
        declare lineage_row record; parent_row record;
        begin
          if uncertainty_evidence is null or btrim(uncertainty_evidence)='' then
            raise exception 'Workspace uncertainty evidence is required';
          end if;
          select scope_id into lineage_row from {schema}.forge_global_workspace_permit_lineages
            where permit_id=permit_identity;
          if not found then raise exception 'Unknown workspace Git permit'; end if;
          perform pg_advisory_xact_lock_shared(hashtext('forge-trust:{schema}'));
          perform 1 from {schema}.forge_global_scopes where id=lineage_row.scope_id for update;
          select * into lineage_row from {schema}.forge_global_workspace_permit_lineages
            where permit_id=permit_identity;
          if not found or lineage_row.completed
            or lineage_row.verifier is distinct from
              encode(sha256(convert_to(completion_secret,'UTF8')),'hex') then
            raise exception 'Invalid workspace Git completion capability';
          end if;
          select state into parent_row from {schema}.forge_global_claims
            where scope_id=lineage_row.scope_id and claim_id=lineage_row.parent_claim_id;
          if parent_row.state <> 'ACTIVE'
            or not exists (select 1 from {schema}.forge_global_workspace_phases
              where scope_id=lineage_row.scope_id and parent_claim_id=lineage_row.parent_claim_id
                and phase='WORKSPACE_ARMED') then
            raise exception 'Workspace Git parent is not armed';
          end if;
          update {schema}.forge_global_claims
            set state='HELD_UNCERTAIN',version=version+1,evidence=uncertainty_evidence
            where scope_id=lineage_row.scope_id and claim_id=lineage_row.parent_claim_id;
          update {schema}.forge_global_workspace_phases set phase='WORKSPACE_UNCERTAIN'
            where scope_id=lineage_row.scope_id and parent_claim_id=lineage_row.parent_claim_id;
          update {schema}.forge_global_workspace_permit_lineages set completed=true
            where scope_id=lineage_row.scope_id and parent_claim_id=lineage_row.parent_claim_id;
          return 'UNCERTAIN';
        end $$`,
      `revoke all on function {schema}.forge_workspace_permit_finish(text,text,text) from public`
    ]
  },
  {
    version: 12,
    statements: [
      `alter table {schema}.forge_global_workspace_permit_lineages
        add column settlement_id text`,
      `alter table {schema}.forge_global_workspace_permit_lineages
        add column settlement_digest text`,
      `alter table {schema}.forge_global_workspace_phases
        add column child_claim_id text`,
      `alter table {schema}.forge_global_workspace_phases
        add column handoff_attestation_id text`,
      `alter table {schema}.forge_global_workspace_phases
        add column handoff_attestation_digest text`,
      `create function {schema}.forge_workspace_recovery_settle(
          target_scope text, parent_id text, permit_identity text,
          run_identity text, generation_identity text, expected_token text,
          attestation_identity text, attestation_digest text,
          signing_identity text, setup_digest text, authorization_identity text,
          workspace_identity text)
        returns text language plpgsql security definer set search_path = pg_catalog as $$
        declare parent_row record; phase_row record; lineage_row record;
          generation_row record; run_row record;
        begin
          if attestation_identity is null or attestation_identity = ''
            or attestation_digest !~ '^sha256:[0-9a-f]{64}$' then
            raise exception 'Recovery requires an exact signed attestation identity';
          end if;
          perform pg_advisory_xact_lock_shared(hashtext('forge-trust:{schema}'));
          if not exists (select 1 from {schema}.forge_global_trust_registry
              where id=1 and policy_version='git-workspace-setup-v1')
            or not exists (select 1 from {schema}.forge_global_trust_keys
              where key_id=signing_identity and state='ACTIVE')
            or exists (select 1 from {schema}.forge_global_trust_revocations
              where (kind='DECISION' and digest=setup_digest)
                or (kind='AUTHORIZATION' and digest=authorization_identity))
            or not exists (select 1 from {schema}.forge_global_control
              where id=1 and state='GLOBAL_READY') then
            raise exception 'Recovery trust is not current';
          end if;
          perform 1 from {schema}.forge_global_scopes
            where id=target_scope and state='ACTIVE_FOR_GLOBAL_CLAIMS' for update;
          if not found then raise exception 'Recovery scope is not active'; end if;
          select state,payload into run_row from {schema}.forge_runs
            where id=run_identity for update;
          if not found or run_row.state <> 'ACTIVE'
            or run_row.payload::jsonb->'run'->>'id' is distinct from run_identity
            or not exists (select 1 from {schema}.forge_global_run_bindings b
              join {schema}.forge_global_aliases a on a.repository_id=b.repository_id
              where b.run_id=run_identity and b.scope_id=target_scope
                and a.scope_id=target_scope and b.repository_id=
                  run_row.payload::jsonb->'run'->>'repositoryId') then
            raise exception 'Recovery run is not active and bound';
          end if;
          select * into parent_row from {schema}.forge_global_claims
            where scope_id=target_scope and claim_id=parent_id;
          select * into phase_row from {schema}.forge_global_workspace_phases
            where scope_id=target_scope and parent_claim_id=parent_id;
          select * into lineage_row from {schema}.forge_global_workspace_permit_lineages
            where scope_id=target_scope and parent_claim_id=parent_id;
          select * into generation_row from {schema}.forge_global_generations
            where id=generation_identity;
          if parent_row.token::text is distinct from expected_token
            or parent_row.owner_json::jsonb->>'runId' is distinct from run_identity
            or parent_row.owner_json::jsonb->>'workspaceId' is distinct from workspace_identity
            or phase_row.workspace_id is distinct from workspace_identity
            or phase_row.execution_generation is distinct from generation_identity
            or phase_row.setup_plan_digest is distinct from setup_digest
            or phase_row.signing_key is distinct from signing_identity
            or phase_row.authorization_digest is distinct from authorization_identity
            or lineage_row.permit_id is distinct from permit_identity
            or lineage_row.workspace_id is distinct from workspace_identity
            or lineage_row.generation_id is distinct from generation_identity
            or lineage_row.token is distinct from parent_row.token
            or lineage_row.owner_json::jsonb is distinct from parent_row.owner_json::jsonb
            or generation_row.state is distinct from 'REVOKED'
            or generation_row.scope_id is distinct from target_scope
            or generation_row.parent_claim_id is distinct from parent_id
            or generation_row.run_id is distinct from run_identity
            or generation_row.workspace_id is distinct from workspace_identity
            or generation_row.setup_plan_digest is distinct from setup_digest
            or generation_row.execution_plan_digest is distinct from phase_row.execution_plan_digest
            or exists (select 1 from {schema}.forge_global_permits
              where scope_id=target_scope and claim_id=parent_id) then
            raise exception 'Recovery parent, lineage, or generation is incompatible';
          end if;
          if lineage_row.settlement_id is not null then
            if lineage_row.settlement_id <> attestation_identity
              or lineage_row.settlement_digest <> attestation_digest
              or not lineage_row.completed
              or phase_row.phase <> 'WORKSPACE_UNCERTAIN'
              or parent_row.state <> 'HELD_UNCERTAIN' then
              raise exception 'Recovery permit settlement identity cannot change';
            end if;
            return 'SETTLED';
          end if;
          if lineage_row.completed then
            if phase_row.phase <> 'WORKSPACE_UNCERTAIN'
              or parent_row.state <> 'HELD_UNCERTAIN' then
              raise exception 'Completed permit has inconsistent authority';
            end if;
          else
            if phase_row.phase <> 'WORKSPACE_ARMED'
              or parent_row.state <> 'ACTIVE' then
              raise exception 'Pending permit is not armed';
            end if;
            update {schema}.forge_global_claims
              set state='HELD_UNCERTAIN',version=version+1,
                evidence='Independent Git permit settlement ' || attestation_identity
              where scope_id=target_scope and claim_id=parent_id;
            update {schema}.forge_global_workspace_phases
              set phase='WORKSPACE_UNCERTAIN'
              where scope_id=target_scope and parent_claim_id=parent_id;
          end if;
          update {schema}.forge_global_workspace_permit_lineages
            set completed=true,settlement_id=attestation_identity,
              settlement_digest=attestation_digest
            where scope_id=target_scope and parent_claim_id=parent_id;
          return 'SETTLED';
        end $$`,
      `revoke all on function {schema}.forge_workspace_recovery_settle(${Array(12).fill('text').join(',')}) from public`,
      `create function {schema}.forge_workspace_recovery_handoff(
          target_scope text, parent_id text, run_identity text, generation_identity text,
          expected_token text, attestation_identity text, attestation_digest text,
          signing_identity text, setup_digest text, authorization_identity text,
          workspace_identity text, workspace_revision text, inspected_path text,
           inspected_branch text, inspected_base text, attempt_fingerprint text)
        returns text language plpgsql security definer set search_path = pg_catalog as $$
        declare parent_row record; phase_row record; lineage_row record;
          generation_row record; run_row record; binding_row record;
          attempt_row record; workspace_row record; child_row record;
          child_id text; resources jsonb; candidate jsonb; existing jsonb;
          allocated_token bigint;
        begin
          if attestation_identity is null or attestation_identity = ''
            or attestation_digest !~ '^sha256:[0-9a-f]{64}$'
            or workspace_revision <> '1' then
            raise exception 'Handoff requires a fresh exact attestation and initial workspace';
          end if;
          perform pg_advisory_xact_lock_shared(hashtext('forge-trust:{schema}'));
          if not exists (select 1 from {schema}.forge_global_trust_registry
              where id=1 and policy_version='git-workspace-setup-v1')
            or not exists (select 1 from {schema}.forge_global_trust_keys
              where key_id=signing_identity and state='ACTIVE')
            or exists (select 1 from {schema}.forge_global_trust_revocations
              where (kind='DECISION' and digest=setup_digest)
                or (kind='AUTHORIZATION' and digest=authorization_identity))
            or not exists (select 1 from {schema}.forge_global_control
              where id=1 and state='GLOBAL_READY') then
            raise exception 'Handoff trust is not current';
          end if;
          perform 1 from {schema}.forge_global_scopes
            where id=target_scope and state='ACTIVE_FOR_GLOBAL_CLAIMS' for update;
          if not found then raise exception 'Handoff scope is not active'; end if;
          select state,payload into run_row from {schema}.forge_runs
            where id=run_identity for update;
          if not found or run_row.state <> 'ACTIVE'
            or run_row.payload::jsonb->'run'->>'id' is distinct from run_identity
            or run_row.payload::jsonb->'run'->'authority'->>'repositoryRoot'
              is distinct from (select b.payload::jsonb->'workspace'->>'integrationRepositoryPath'
                from {schema}.forge_records b where b.run_id=run_identity and b.kind='binding'
                  and b.key=(select c.owner_json::jsonb->>'taskId' from {schema}.forge_global_claims c
                    where c.scope_id=target_scope and c.claim_id=parent_id))
            or run_row.payload::jsonb->'run'->'authority'->>'baseCommit' is distinct from inspected_base
            or not exists (select 1 from {schema}.forge_global_run_bindings b
              join {schema}.forge_global_aliases a on a.repository_id=b.repository_id
              where b.run_id=run_identity and b.scope_id=target_scope
                and a.scope_id=target_scope and b.repository_id=
                  run_row.payload::jsonb->'run'->>'repositoryId') then
            raise exception 'Handoff run is not active and approved';
          end if;
          select * into parent_row from {schema}.forge_global_claims
            where scope_id=target_scope and claim_id=parent_id;
          select * into phase_row from {schema}.forge_global_workspace_phases
            where scope_id=target_scope and parent_claim_id=parent_id;
          select * into lineage_row from {schema}.forge_global_workspace_permit_lineages
            where scope_id=target_scope and parent_claim_id=parent_id;
          select * into generation_row from {schema}.forge_global_generations
            where id=generation_identity;
          if parent_row.token::text is distinct from expected_token
            or parent_row.owner_json::jsonb->>'runId' is distinct from run_identity
            or parent_row.owner_json::jsonb->>'workspaceId' is distinct from workspace_identity
            or phase_row.workspace_id is distinct from workspace_identity
            or phase_row.execution_generation is distinct from generation_identity
            or phase_row.setup_plan_digest is distinct from setup_digest
            or phase_row.signing_key is distinct from signing_identity
            or phase_row.authorization_digest is distinct from authorization_identity
            or lineage_row.workspace_id is distinct from workspace_identity
            or lineage_row.generation_id is distinct from generation_identity
            or lineage_row.token is distinct from parent_row.token
            or lineage_row.owner_json::jsonb is distinct from parent_row.owner_json::jsonb
            or not lineage_row.completed
            or lineage_row.settlement_id is distinct from attestation_identity
            or lineage_row.settlement_digest is distinct from attestation_digest
            or generation_row.state is distinct from 'REVOKED'
            or generation_row.scope_id is distinct from target_scope
            or generation_row.parent_claim_id is distinct from parent_id
            or generation_row.run_id is distinct from run_identity
            or generation_row.task_id is distinct from parent_row.owner_json::jsonb->>'taskId'
            or generation_row.attempt_id is distinct from parent_row.owner_json::jsonb->>'attemptId'
            or generation_row.workspace_id is distinct from workspace_identity
            or generation_row.setup_plan_digest is distinct from setup_digest
            or generation_row.execution_plan_digest is distinct from phase_row.execution_plan_digest
            or exists (select 1 from {schema}.forge_global_permits
              where scope_id=target_scope and claim_id=parent_id) then
            raise exception 'Handoff parent, permit or generation is incompatible';
          end if;
          select payload into binding_row from {schema}.forge_records
            where run_id=run_identity and kind='binding'
              and key=parent_row.owner_json::jsonb->>'taskId';
          select payload into attempt_row from {schema}.forge_records
            where run_id=run_identity and kind='builder'
              and key=parent_row.owner_json::jsonb->>'attemptId';
          select payload into workspace_row from {schema}.forge_records
            where run_id=run_identity and kind='workspace' and key=workspace_identity;
          resources := binding_row.payload::jsonb->'leasePlan'->'predictedResources';
          if binding_row.payload::jsonb->>'agentId' is distinct from parent_row.owner_json::jsonb->>'agentId'
            or binding_row.payload::jsonb->'workspace'->>'id' is distinct from workspace_identity
            or binding_row.payload::jsonb->'leasePlan'->>'taskId' is distinct from parent_row.owner_json::jsonb->>'taskId'
            or jsonb_typeof(resources) is distinct from 'array'
            or jsonb_array_length(resources)=0
             or attempt_row.payload::jsonb->>'state' is distinct from 'STARTING'
            or attempt_row.payload::jsonb->>'runId' is distinct from run_identity
            or attempt_row.payload::jsonb->>'taskId' is distinct from parent_row.owner_json::jsonb->>'taskId'
            or attempt_row.payload::jsonb->>'agentId' is distinct from parent_row.owner_json::jsonb->>'agentId'
            or attempt_row.payload::jsonb->>'workspaceId' is distinct from workspace_identity
             or attempt_row.payload::jsonb->>'leasePlanFingerprint' is distinct from attempt_fingerprint
            or workspace_row.payload::jsonb->>'revision' is distinct from workspace_revision
            or workspace_row.payload::jsonb->>'phase' is distinct from 'READY_TO_INTEGRATE'
            or workspace_row.payload::jsonb->>'id' is distinct from workspace_identity
            or workspace_row.payload::jsonb->>'runId' is distinct from run_identity
            or workspace_row.payload::jsonb->>'taskId' is distinct from parent_row.owner_json::jsonb->>'taskId'
            or workspace_row.payload::jsonb->>'workspacePath' is distinct from inspected_path
            or workspace_row.payload::jsonb->>'branchName' is distinct from inspected_branch
            or workspace_row.payload::jsonb->>'integrationRepositoryPath' is distinct from
              run_row.payload::jsonb->'run'->'authority'->>'repositoryRoot'
            or workspace_row.payload::jsonb->>'baseRef' is distinct from
              binding_row.payload::jsonb->'workspace'->>'baseRef'
            or workspace_row.payload::jsonb->>'integrationRef' is distinct from
              binding_row.payload::jsonb->'workspace'->>'integrationRef'
            or phase_row.execution_plan_digest is null then
            raise exception 'Handoff execution plan, attempt or Git workspace is incompatible';
          end if;
          child_id := 'execution-' || encode(sha256(convert_to(
             'forge-workspace-child-v1:' || parent_id || ':' || run_identity || ':' ||
               (parent_row.owner_json::jsonb->>'attemptId'),'UTF8')),'hex');
          if phase_row.phase='HANDOFF_COMMITTED' then
            select * into child_row from {schema}.forge_global_claims
              where scope_id=target_scope and claim_id=child_id;
            select coalesce(jsonb_agg(resource_json::jsonb order by resource_json::jsonb), '[]'::jsonb)
              into existing from {schema}.forge_global_leases
              where scope_id=target_scope and claim_id=child_id;
            select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
              into candidate from jsonb_array_elements(resources) value;
            if phase_row.child_claim_id is distinct from child_id
              or phase_row.handoff_attestation_id is distinct from attestation_identity
              or phase_row.handoff_attestation_digest is distinct from attestation_digest
              or parent_row.state is distinct from 'RELEASED'
              or child_row.state is distinct from 'ACTIVE'
              or child_row.owner_json::jsonb is distinct from parent_row.owner_json::jsonb
              or existing is distinct from candidate then
              raise exception 'Handoff replay is not the original active child';
            end if;
            return 'GRANTED:' || child_id || ':' || child_row.token::text;
          end if;
          if phase_row.phase is distinct from 'WORKSPACE_UNCERTAIN'
            or parent_row.state is distinct from 'HELD_UNCERTAIN'
            or parent_row.version < 2
            or phase_row.child_claim_id is not null
            or phase_row.handoff_attestation_id is not null
            or phase_row.handoff_attestation_digest is not null then
            raise exception 'Handoff parent is not uncertain';
          end if;
           if exists (select 1 from {schema}.forge_global_claims c
             where c.scope_id=target_scope and c.claim_id<>parent_id
               and c.state<>'RELEASED'
               and (not exists (select 1 from {schema}.forge_global_leases l
                    where l.scope_id=c.scope_id and l.claim_id=c.claim_id)
                 or exists (select 1 from {schema}.forge_global_leases l
                    cross join lateral jsonb_array_elements(resources) proposed(value)
                    where l.scope_id=c.scope_id and l.claim_id=c.claim_id
                      and (l.resource_json::jsonb->>'type'='repository'
                        or proposed.value->>'type'='repository'
                        or (l.resource_json::jsonb->>'type'='shared-resource'
                          and proposed.value->>'type'='shared-resource'
                          and l.resource_json::jsonb->>'resourceId'=proposed.value->>'resourceId')
                        or (l.resource_json::jsonb->>'type'<>'shared-resource'
                          and proposed.value->>'type'<>'shared-resource'
                          and l.resource_json::jsonb->>'projectId'=proposed.value->>'projectId'
                          and (l.resource_json::jsonb->>'type'='project'
                            or proposed.value->>'type'='project'
                            or (l.resource_json::jsonb->>'fileId'=proposed.value->>'fileId'
                              and (l.resource_json::jsonb->>'type'='file'
                                or proposed.value->>'type'='file'
                                or l.resource_json::jsonb->>'symbolId'=proposed.value->>'symbolId'
                                or coalesce(l.resource_json::jsonb->'ancestorSymbolIds','[]'::jsonb)
                                  ? (proposed.value->>'symbolId')
                                or coalesce(proposed.value->'ancestorSymbolIds','[]'::jsonb)
                                  ? (l.resource_json::jsonb->>'symbolId'))))))))) then
            return 'BLOCKED';
          end if;
          select next_token into allocated_token from {schema}.forge_global_scopes where id=target_scope;
          if allocated_token >= 9007199254740991 or allocated_token < parent_row.token then
            raise exception 'Handoff token exhausted or stale';
          end if;
          allocated_token := allocated_token+1;
          update {schema}.forge_global_scopes set next_token=allocated_token where id=target_scope;
          update {schema}.forge_global_claims set state='RELEASED',version=version+1,
            evidence='Signed handoff ' || attestation_identity
            where scope_id=target_scope and claim_id=parent_id;
          insert into {schema}.forge_global_claims
            values (target_scope,child_id,parent_row.owner_json,allocated_token,'ACTIVE',1,null);
          insert into {schema}.forge_global_leases(scope_id,claim_id,lease_id,resource_json)
            select target_scope,child_id,gen_random_uuid()::text,value::text
            from jsonb_array_elements(resources) value;
          update {schema}.forge_global_workspace_phases set
            phase='HANDOFF_COMMITTED',child_claim_id=child_id,
            handoff_attestation_id=attestation_identity,
            handoff_attestation_digest=attestation_digest
            where scope_id=target_scope and parent_claim_id=parent_id;
          return 'GRANTED:' || child_id || ':' || allocated_token::text;
        end $$`,
      `revoke all on function {schema}.forge_workspace_recovery_handoff(${Array(16).fill('text').join(',')}) from public`
    ]
  }
] as const;

export const POSTGRES_AUTHORITY_SCHEMA_VERSION = 2;
export const POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION = 12;
export type PostgresAuthoritySchemaVersion =
  | 1
  | typeof POSTGRES_AUTHORITY_SCHEMA_VERSION
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | typeof POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION;

export type PostgresAuthorityWriterRoles = {
  trustAdminRole: string;
  generationIssuerRole: string;
  setupAdmissionRole?: string;
  recoveryRole?: string;
};

const checksum = (statements: readonly string[]): string =>
  createHash('sha256').update(statements.join('\n')).digest('hex');
const quote = (identifier: string): string => `"${identifier}"`;
const globalTables = [
  'forge_global_control',
  'forge_global_scopes',
  'forge_global_aliases',
  'forge_global_run_bindings',
  'forge_global_claims',
  'forge_global_leases',
  'forge_global_permits',
  'forge_global_legacy_owners',
  'forge_global_audit',
  'forge_global_workspace_phases',
  'forge_global_trust_registry',
  'forge_global_trust_keys',
  'forge_global_trust_revocations',
  'forge_global_generations',
  'forge_global_workspace_permit_lineages'
] as const;
const globalRuntimePrivileges = {
  forge_global_control: ['SELECT', 'UPDATE'],
  forge_global_scopes: ['SELECT', 'INSERT', 'UPDATE'],
  forge_global_aliases: ['SELECT', 'INSERT'],
  forge_global_run_bindings: ['SELECT', 'INSERT'],
  forge_global_claims: ['SELECT', 'INSERT', 'UPDATE'],
  forge_global_leases: ['SELECT', 'INSERT'],
  forge_global_permits: ['SELECT', 'INSERT', 'DELETE'],
  forge_global_legacy_owners: ['SELECT', 'INSERT', 'UPDATE'],
  forge_global_audit: ['SELECT', 'INSERT'],
  forge_global_workspace_phases: ['SELECT'],
  forge_global_trust_registry: ['SELECT'],
  forge_global_trust_keys: ['SELECT'],
  forge_global_trust_revocations: ['SELECT'],
  forge_global_generations: ['SELECT'],
  forge_global_workspace_permit_lineages: ['SELECT']
} as const satisfies Record<(typeof globalTables)[number], readonly string[]>;

/** The runtime adapter accepts only an explicit login, never role-assumption startup options. */
export const assertPostgresAuthorityLogin = (
  configuration: PostgresEvidenceStoreConfiguration
): void => {
  assertPostgresEvidenceStoreConfiguration(configuration);
  const url = new URL(configuration.connectionString);
  if (decodeURIComponent(url.username) !== configuration.role || url.searchParams.size !== 0) {
    throw new Error(
      'PostgreSQL authority requires an explicit runtime login without startup options'
    );
  }
};

// PostgreSQL 17 adds MAINTAIN; extend the privilege audit before supporting it.
const assertSupportedServerVersion = async (sql: TransactionSql | Sql): Promise<void> => {
  const rows = await sql`select current_setting('server_version_num')::integer as version`;
  const version = Number(rows[0]?.version);
  if (!Number.isInteger(version) || version < 140000 || version >= 170000) {
    throw new Error('PostgreSQL authority requires server major version 14 through 16');
  }
};

const expectedColumns = {
  forge_schema_migrations: [
    ['version', 'integer', true],
    ['checksum', 'text', true],
    ['applied_at', 'timestamp with time zone', true]
  ],
  forge_runs: [
    ['id', 'text', true],
    ['state', 'text', true],
    ['payload', 'text', true]
  ],
  forge_records: [
    ['run_id', 'text', true],
    ['kind', 'text', true],
    ['key', 'text', true],
    ['payload', 'text', true]
  ]
} as const;

const globalColumns = {
  forge_global_control: [
    ['id', 'integer', true],
    ['state', 'text', true],
    ['next_token', 'bigint', true]
  ],
  forge_global_scopes: [
    ['id', 'text', true],
    ['state', 'text', true]
  ],
  forge_global_aliases: [
    ['repository_id', 'text', true],
    ['scope_id', 'text', true]
  ],
  forge_global_run_bindings: [
    ['run_id', 'text', true],
    ['repository_id', 'text', true],
    ['scope_id', 'text', true]
  ],
  forge_global_claims: [
    ['scope_id', 'text', true],
    ['claim_id', 'text', true],
    ['owner_json', 'text', true],
    ['token', 'bigint', true],
    ['state', 'text', true],
    ['version', 'bigint', true],
    ['evidence', 'text', false]
  ],
  forge_global_leases: [
    ['scope_id', 'text', true],
    ['claim_id', 'text', true],
    ['lease_id', 'text', true],
    ['resource_json', 'text', true]
  ],
  forge_global_permits: [
    ['id', 'text', true],
    ['scope_id', 'text', true],
    ['claim_id', 'text', true],
    ['owner_json', 'text', true],
    ['token', 'bigint', true],
    ['resource_json', 'text', true],
    ['verifier', 'text', true]
  ],
  forge_global_legacy_owners: [
    ['key', 'text', true],
    ['owner_json', 'text', true],
    ['disposition', 'text', false],
    ['evidence', 'text', false]
  ],
  forge_global_audit: [
    ['id', 'text', true],
    ['action', 'text', true],
    ['subject', 'text', true],
    ['evidence', 'text', true]
  ],
  forge_global_workspace_phases: [
    ['scope_id', 'text', true],
    ['parent_claim_id', 'text', true],
    ['phase', 'text', true],
    ['setup_plan_digest', 'text', false],
    ['execution_plan_digest', 'text', false],
    ['execution_generation', 'text', false],
    ['workspace_id', 'text', false],
    ['signing_key', 'text', false],
    ['authorization_digest', 'text', false],
    ['child_claim_id', 'text', false],
    ['handoff_attestation_id', 'text', false],
    ['handoff_attestation_digest', 'text', false]
  ],
  forge_global_trust_registry: [
    ['id', 'integer', true],
    ['revision', 'bigint', true],
    ['policy_version', 'text', true]
  ],
  forge_global_trust_keys: [
    ['key_id', 'text', true],
    ['public_key', 'text', true],
    ['state', 'text', true]
  ],
  forge_global_trust_revocations: [
    ['kind', 'text', true],
    ['digest', 'text', true],
    ['registry_revision', 'bigint', true]
  ],
  forge_global_generations: [
    ['id', 'text', true],
    ['scope_id', 'text', true],
    ['parent_claim_id', 'text', true],
    ['run_id', 'text', true],
    ['task_id', 'text', true],
    ['attempt_id', 'text', true],
    ['workspace_id', 'text', true],
    ['supervisor_id', 'text', true],
    ['setup_plan_digest', 'text', true],
    ['execution_plan_digest', 'text', true],
    ['state', 'text', true]
  ],
  forge_global_workspace_permit_lineages: [
    ['scope_id', 'text', true],
    ['parent_claim_id', 'text', true],
    ['permit_id', 'text', true],
    ['owner_json', 'text', true],
    ['token', 'bigint', true],
    ['generation_id', 'text', true],
    ['workspace_id', 'text', true],
    ['verifier', 'text', true],
    ['completed', 'boolean', true],
    ['settlement_id', 'text', false],
    ['settlement_digest', 'text', false]
  ]
} as const;

const installedGlobalTables = (version: number): readonly (typeof globalTables)[number][] =>
  globalTables.filter(
    (name) =>
      (version >= 5 || name !== 'forge_global_workspace_phases') &&
      (version >= 11 || name !== 'forge_global_workspace_permit_lineages') &&
      (version >= 7 ||
        (!name.startsWith('forge_global_trust_') && name !== 'forge_global_generations'))
  );

const assertGlobalAuthorityShape = async (
  sql: TransactionSql | Sql,
  schema: string,
  version: number
): Promise<void> => {
  const relations = await sql`select c.relname as name, c.relkind as kind,
    c.relpersistence as persistence, c.relrowsecurity as row_security,
    c.relforcerowsecurity as force_row_security
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=${schema} and c.relname like 'forge_global_%' and c.relkind in ('r','p')
    order by c.relname`;
  if (
    JSON.stringify(
      relations.map((row) => [
        row.name,
        row.kind,
        row.persistence,
        row.row_security,
        row.force_row_security
      ])
    ) !==
    JSON.stringify(
      installedGlobalTables(version)
        .toSorted()
        .map((name) => [name, 'r', 'p', false, false])
    )
  ) {
    throw new Error('PostgreSQL global authority relation semantics are incompatible');
  }
  const columns = await sql`select c.relname as table_name, a.attname as column_name,
    format_type(a.atttypid,a.atttypmod) as data_type, a.attnotnull as not_null
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid
    where n.nspname=${schema} and c.relname like 'forge_global_%'
      and c.relkind='r' and a.attnum>0 and not a.attisdropped
    order by c.relname,a.attnum`;
  const expected = installedGlobalTables(version)
    .toSorted()
    .flatMap((table) => {
      const original = globalColumns[table]
        .filter(
          ([name]) =>
            (version < 4 || !(table === 'forge_global_control' && name === 'next_token')) &&
            (version >= 6 ||
              !(
                table === 'forge_global_workspace_phases' &&
                [
                  'setup_plan_digest',
                  'execution_plan_digest',
                  'execution_generation',
                  'workspace_id'
                ].includes(name)
              )) &&
            (version >= 9 ||
              !(
                table === 'forge_global_workspace_phases' &&
                ['signing_key', 'authorization_digest'].includes(name)
              )) &&
            (version >= 12 ||
              !(
                (table === 'forge_global_workspace_phases' &&
                  [
                    'child_claim_id',
                    'handoff_attestation_id',
                    'handoff_attestation_digest'
                  ].includes(name)) ||
                (table === 'forge_global_workspace_permit_lineages' &&
                  ['settlement_id', 'settlement_digest'].includes(name))
              ))
        )
        .map(([name, type, notNull]) => [table, name, type, notNull]);
      return version >= 4 && table === 'forge_global_scopes'
        ? [...original, [table, 'next_token', 'bigint', true]]
        : original;
    });
  if (
    JSON.stringify(
      columns.map((row) => [row.table_name, row.column_name, row.data_type, row.not_null])
    ) !== JSON.stringify(expected)
  ) {
    throw new Error('PostgreSQL global authority columns are incompatible');
  }
  const constraints = await sql`select c.relname as table_name, con.contype as kind,
    pg_get_constraintdef(con.oid) as definition
    from pg_constraint con join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=${schema} and c.relname like 'forge_global_%'
    order by c.relname, con.contype, pg_get_constraintdef(con.oid)`;
  const expectedConstraints = [
    [
      'forge_global_aliases',
      'f',
      `FOREIGN KEY (scope_id) REFERENCES ${schema}.forge_global_scopes(id)`
    ],
    ['forge_global_aliases', 'p', 'PRIMARY KEY (repository_id)'],
    ['forge_global_audit', 'p', 'PRIMARY KEY (id)'],
    [
      'forge_global_claims',
      'f',
      `FOREIGN KEY (scope_id) REFERENCES ${schema}.forge_global_scopes(id)`
    ],
    ['forge_global_claims', 'p', 'PRIMARY KEY (scope_id, claim_id)'],
    ...(version >= 7
      ? [
          [
            'forge_global_generations',
            'c',
            "CHECK ((state = ANY (ARRAY['ISSUED'::text, 'REVOKED'::text])))"
          ],
          [
            'forge_global_generations',
            'f',
            `FOREIGN KEY (scope_id) REFERENCES ${schema}.forge_global_scopes(id)`
          ],
          [
            'forge_global_generations',
            'f',
            `FOREIGN KEY (scope_id, parent_claim_id) REFERENCES ${schema}.forge_global_claims(scope_id, claim_id)`
          ],
          ['forge_global_generations', 'p', 'PRIMARY KEY (id)'],
          [
            'forge_global_trust_keys',
            'c',
            "CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'RETIRED'::text, 'REVOKED'::text])))"
          ],
          ['forge_global_trust_keys', 'p', 'PRIMARY KEY (key_id)'],
          ['forge_global_trust_registry', 'c', 'CHECK ((id = 1))'],
          ['forge_global_trust_registry', 'p', 'PRIMARY KEY (id)'],
          [
            'forge_global_trust_revocations',
            'c',
            "CHECK ((kind = ANY (ARRAY['DECISION'::text, 'AUTHORIZATION'::text])))"
          ],
          ['forge_global_trust_revocations', 'p', 'PRIMARY KEY (kind, digest)']
        ]
      : []),
    ['forge_global_control', 'c', 'CHECK ((id = 1))'],
    ['forge_global_control', 'p', 'PRIMARY KEY (id)'],
    [
      'forge_global_leases',
      'f',
      `FOREIGN KEY (scope_id, claim_id) REFERENCES ${schema}.forge_global_claims(scope_id, claim_id)`
    ],
    ['forge_global_leases', 'p', 'PRIMARY KEY (scope_id, claim_id, lease_id)'],
    ['forge_global_legacy_owners', 'p', 'PRIMARY KEY (key)'],
    [
      'forge_global_permits',
      'f',
      `FOREIGN KEY (scope_id, claim_id) REFERENCES ${schema}.forge_global_claims(scope_id, claim_id)`
    ],
    ['forge_global_permits', 'p', 'PRIMARY KEY (id)'],
    ['forge_global_run_bindings', 'f', `FOREIGN KEY (run_id) REFERENCES ${schema}.forge_runs(id)`],
    [
      'forge_global_run_bindings',
      'f',
      `FOREIGN KEY (scope_id) REFERENCES ${schema}.forge_global_scopes(id)`
    ],
    ['forge_global_run_bindings', 'p', 'PRIMARY KEY (run_id)'],
    ['forge_global_scopes', 'p', 'PRIMARY KEY (id)'],
    ...(version >= 11
      ? [
          [
            'forge_global_workspace_permit_lineages',
            'p',
            'PRIMARY KEY (scope_id, parent_claim_id)'
          ],
          ['forge_global_workspace_permit_lineages', 'u', 'UNIQUE (permit_id)'],
          [
            'forge_global_workspace_permit_lineages',
            'f',
            `FOREIGN KEY (scope_id, parent_claim_id) REFERENCES ${schema}.forge_global_claims(scope_id, claim_id)`
          ]
        ]
      : []),
    ...(version >= 5
      ? [
          [
            'forge_global_workspace_phases',
            'c',
            "CHECK ((phase = ANY (ARRAY['INITIAL_ADMITTED'::text, 'WORKSPACE_ARMED'::text, 'WORKSPACE_UNCERTAIN'::text, 'HANDOFF_COMMITTED'::text, 'ABANDONED'::text])))"
          ],
          [
            'forge_global_workspace_phases',
            'f',
            `FOREIGN KEY (scope_id, parent_claim_id) REFERENCES ${schema}.forge_global_claims(scope_id, claim_id)`
          ],
          ['forge_global_workspace_phases', 'p', 'PRIMARY KEY (scope_id, parent_claim_id)']
        ]
      : [])
  ].toSorted(
    ([tableA, kindA, defA], [tableB, kindB, defB]) =>
      tableA.localeCompare(tableB) ||
      kindA.localeCompare(kindB) ||
      (defA < defB ? -1 : defA > defB ? 1 : 0)
  );
  if (
    JSON.stringify(constraints.map((row) => [row.table_name, row.kind, row.definition])) !==
    JSON.stringify(expectedConstraints)
  ) {
    throw new Error('PostgreSQL global authority constraints are incompatible');
  }
  const triggers = await sql`select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=${schema} and c.relname like 'forge_global_%'
      and not t.tgisinternal limit 1`;
  const defaults = await sql`select 1 from pg_attrdef d join pg_class c on c.oid=d.adrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=${schema} and c.relname like 'forge_global_%' limit 1`;
  const rules = await sql`select 1 from pg_rewrite r join pg_class c on c.oid=r.ev_class
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=${schema} and c.relname like 'forge_global_%' limit 1`;
  const extraIndexes = await sql`select c.relname as table_name, i.relname as index_name,
    x.indisunique as unique_index, pg_get_indexdef(x.indexrelid) as definition
    from pg_index x join pg_class c on c.oid=x.indrelid
    join pg_class i on i.oid=x.indexrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=${schema} and c.relname like 'forge_global_%'
      and not x.indisprimary order by c.relname,i.relname`;
  const allowedLineageIndex = `${schema}.forge_global_workspace_permit_lineages`;
  if (
    triggers.length > 0 ||
    defaults.length > 0 ||
    rules.length > 0 ||
    JSON.stringify(
      extraIndexes.map((row) => [row.table_name, row.index_name, row.unique_index, row.definition])
    ) !==
      JSON.stringify(
        version >= 11
          ? [
              [
                'forge_global_workspace_permit_lineages',
                'forge_global_workspace_permit_lineages_permit_id_key',
                true,
                `CREATE UNIQUE INDEX forge_global_workspace_permit_lineages_permit_id_key ON ${allowedLineageIndex} USING btree (permit_id)`
              ]
            ]
          : []
      )
  ) {
    throw new Error(
      'PostgreSQL global authority triggers, rules, defaults, or indexes are incompatible'
    );
  }
};

const assertAuthorityShape = async (
  sql: TransactionSql | Sql,
  schema: string,
  version: number
): Promise<void> => {
  const tables: (keyof typeof expectedColumns)[] =
    version >= 1
      ? ['forge_schema_migrations', 'forge_runs', 'forge_records']
      : ['forge_schema_migrations'];
  const relations = await sql`select c.relname as name, c.relkind as kind,
    c.relpersistence as persistence, c.relrowsecurity as row_security,
    c.relforcerowsecurity as force_row_security
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname in ('forge_schema_migrations','forge_runs','forge_records')
    order by c.relname`;
  if (
    JSON.stringify(
      relations.map((relation) => [
        relation.name,
        relation.kind,
        relation.persistence,
        relation.row_security,
        relation.force_row_security
      ])
    ) !== JSON.stringify(tables.toSorted().map((table) => [table, 'r', 'p', false, false]))
  ) {
    throw new Error('PostgreSQL authority relation semantics are incompatible');
  }
  const defaults = await sql`select c.relname as table_name, a.attname as column_name,
    pg_get_expr(d.adbin, d.adrelid) as expression
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    join pg_class c on c.oid = d.adrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname in ('forge_schema_migrations','forge_runs','forge_records')
    order by c.relname, a.attname`;
  if (
    defaults.length !== 1 ||
    defaults[0]?.table_name !== 'forge_schema_migrations' ||
    defaults[0].column_name !== 'applied_at' ||
    defaults[0].expression !== 'now()'
  ) {
    throw new Error('PostgreSQL authority column defaults are incompatible');
  }
  const triggers = await sql`select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname in ('forge_schema_migrations','forge_runs','forge_records')
      and not t.tgisinternal limit 1`;
  const rules = await sql`select 1 from pg_rewrite r join pg_class c on c.oid = r.ev_class
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname in ('forge_schema_migrations','forge_runs','forge_records')
    limit 1`;
  if (triggers.length > 0 || rules.length > 0) {
    throw new Error('PostgreSQL authority triggers or rules are incompatible');
  }
  const columns = await sql`select c.relname as table_name, a.attname as column_name,
    format_type(a.atttypid, a.atttypmod) as data_type, a.attnotnull as not_null
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = ${schema} and c.relname in ('forge_schema_migrations','forge_runs','forge_records')
      and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum`;
  const actual = columns.map((row) => [
    row.table_name,
    row.column_name,
    row.data_type,
    row.not_null
  ]);
  const expected = tables.flatMap((table) => {
    const columnsForTable = expectedColumns[table];
    return columnsForTable.map(([name, type, notNull]) => [table, name, type, notNull]);
  });
  if (
    JSON.stringify(actual) !==
    JSON.stringify(expected.toSorted(([a], [b]) => String(a).localeCompare(String(b))))
  ) {
    throw new Error('PostgreSQL authority table columns are incompatible');
  }
  const constraints = await sql`select c.relname as table_name, con.contype as kind,
    pg_get_constraintdef(con.oid) as definition
    from pg_constraint con join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname in ('forge_schema_migrations','forge_runs','forge_records')
    order by c.relname, con.contype`;
  const actualConstraints = constraints.map((row) => [row.table_name, row.kind, row.definition]);
  const expectedConstraints =
    version >= 1
      ? [
          ['forge_records', 'f', `FOREIGN KEY (run_id) REFERENCES ${schema}.forge_runs(id)`],
          ['forge_records', 'p', 'PRIMARY KEY (run_id, kind, key)'],
          ['forge_runs', 'p', 'PRIMARY KEY (id)'],
          ['forge_schema_migrations', 'p', 'PRIMARY KEY (version)']
        ]
      : [['forge_schema_migrations', 'p', 'PRIMARY KEY (version)']];
  if (JSON.stringify(actualConstraints) !== JSON.stringify(expectedConstraints)) {
    throw new Error('PostgreSQL authority table constraints are incompatible');
  }
  const indexes = await sql`select c.relname as table_name, i.relname as index_name,
    pg_get_indexdef(i.oid) as definition
    from pg_index x join pg_class c on c.oid = x.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class i on i.oid = x.indexrelid
    where n.nspname = ${schema} and i.relname = 'forge_records_kind_run_idx'`;
  const expectedIndex = `CREATE INDEX forge_records_kind_run_idx ON ${schema}.forge_records USING btree (kind, run_id)`;
  if (
    version >= 2 &&
    (indexes.length !== 1 ||
      indexes[0]?.table_name !== 'forge_records' ||
      indexes[0].definition !== expectedIndex)
  ) {
    throw new Error(
      'PostgreSQL authority schema is missing required index or its definition is incompatible'
    );
  }
  if (version < 2 && indexes.length !== 0) {
    throw new Error('PostgreSQL authority schema contains an unexpected future index');
  }
};

const assertRestrictedWriterFunctions = async (
  sql: TransactionSql | Sql,
  schema: string,
  runtimeRole: string,
  version = 8
): Promise<void> => {
  const functions = await sql`select p.proname as name, oidvectortypes(p.proargtypes) as arguments,
    p.proowner::regrole::text as owner, p.prosecdef as security_definer,
    p.proconfig as configuration, obj_description(p.oid,'pg_proc') as writer_roles,
    (select coalesce(json_agg(json_build_object('grantee',a.grantee::regrole::text,
       'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantee), '[]'::json)
       from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       where a.grantee <> p.proowner) as grants,
    has_function_privilege(${runtimeRole},p.oid,'EXECUTE') as runtime_execute,
    has_function_privilege('public',p.oid,'EXECUTE') as public_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=${schema} order by p.proname`;
  const expected = [
    ['forge_generation_write', 'text, text, text, text, text, text, text, text, text, text, text'],
    ...(version >= 9 ? [['forge_setup_admit', Array(21).fill('text').join(', ')]] : []),
    ...(version >= 10 ? [['forge_setup_arm', Array(22).fill('text').join(', ')]] : []),
    ['forge_trust_write', 'text, text, text'],
    ...(version >= 11
      ? [
          ['forge_workspace_permit_begin', Array(26).fill('text').join(', ')],
          ['forge_workspace_permit_finish', 'text, text, text']
        ]
      : []),
    ...(version >= 12
      ? [
          ['forge_workspace_recovery_handoff', Array(16).fill('text').join(', ')],
          ['forge_workspace_recovery_settle', Array(12).fill('text').join(', ')]
        ]
      : [])
  ];
  const owner =
    await sql`select nspowner::regrole::text as name from pg_namespace where nspname=${schema}`;
  const recorded = functions[0]?.writer_roles;
  const setupBinding =
    version >= 9 ? functions.find((fn) => fn.name === 'forge_setup_admit')?.writer_roles : null;
  const armBinding =
    version >= 10 ? functions.find((fn) => fn.name === 'forge_setup_arm')?.writer_roles : null;
  const permitBinding =
    version >= 11
      ? functions.find((fn) => fn.name === 'forge_workspace_permit_begin')?.writer_roles
      : null;
  const finishBinding =
    version >= 11
      ? functions.find((fn) => fn.name === 'forge_workspace_permit_finish')?.writer_roles
      : null;
  const recoveryBinding =
    version >= 12
      ? functions.find((fn) => fn.name === 'forge_workspace_recovery_settle')?.writer_roles
      : null;
  const handoffBinding =
    version >= 12
      ? functions.find((fn) => fn.name === 'forge_workspace_recovery_handoff')?.writer_roles
      : null;
  let recoveryRole: string | undefined;
  if (recoveryBinding !== null && recoveryBinding !== undefined) {
    const value = String(recoveryBinding);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error('PostgreSQL recovery role binding is incompatible');
    }
    recoveryRole = value;
  }
  let setupRole: string | undefined;
  if (setupBinding !== null && setupBinding !== undefined) {
    const value = String(setupBinding);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error('PostgreSQL setup admission role binding is incompatible');
    }
    setupRole = value;
  }
  let writers: PostgresAuthorityWriterRoles | undefined;
  if (recorded !== null && recorded !== undefined) {
    try {
      const parsed: unknown = JSON.parse(String(recorded));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Object.keys(parsed).toSorted().join(',') !== 'generationIssuerRole,trustAdminRole' ||
        !('trustAdminRole' in parsed) ||
        !('generationIssuerRole' in parsed) ||
        typeof parsed.trustAdminRole !== 'string' ||
        typeof parsed.generationIssuerRole !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.trustAdminRole) ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.generationIssuerRole) ||
        parsed.trustAdminRole === parsed.generationIssuerRole
      ) {
        throw new Error('invalid writer roles');
      }
      writers = {
        trustAdminRole: parsed.trustAdminRole,
        generationIssuerRole: parsed.generationIssuerRole
      };
    } catch {
      throw new Error('PostgreSQL restricted authority writer role binding is incompatible');
    }
  }
  if (
    (version >= 10 && armBinding !== setupBinding) ||
    (version >= 12 && handoffBinding !== recoveryBinding) ||
    (version >= 11 && permitBinding !== setupBinding) ||
    (version >= 11 && finishBinding !== setupBinding) ||
    functions.length !== expected.length ||
    functions.some(
      (fn, index) =>
        fn.name !== expected[index]?.[0] ||
        fn.arguments !== expected[index]?.[1] ||
        fn.owner !== owner[0]?.name ||
        fn.security_definer !== true ||
        JSON.stringify(fn.configuration) !== JSON.stringify(['search_path=pg_catalog']) ||
        fn.writer_roles !==
          (fn.name === 'forge_setup_admit' ||
          fn.name === 'forge_setup_arm' ||
          fn.name === 'forge_workspace_permit_begin' ||
          fn.name === 'forge_workspace_permit_finish'
            ? (setupRole ?? null)
            : fn.name === 'forge_workspace_recovery_settle' ||
                fn.name === 'forge_workspace_recovery_handoff'
              ? (recoveryRole ?? null)
              : writers === undefined
                ? null
                : JSON.stringify(writers)) ||
        JSON.stringify(fn.grants) !==
          JSON.stringify(
            fn.name === 'forge_setup_admit' ||
              fn.name === 'forge_setup_arm' ||
              fn.name === 'forge_workspace_permit_begin' ||
              fn.name === 'forge_workspace_permit_finish'
              ? setupRole === undefined
                ? []
                : [{ grantee: setupRole, privilege: 'EXECUTE', grantable: false }]
              : fn.name === 'forge_workspace_recovery_settle' ||
                  fn.name === 'forge_workspace_recovery_handoff'
                ? recoveryRole === undefined
                  ? []
                  : [{ grantee: recoveryRole, privilege: 'EXECUTE', grantable: false }]
                : writers === undefined
                  ? []
                  : [
                      {
                        grantee:
                          fn.name === 'forge_trust_write'
                            ? writers.trustAdminRole
                            : writers.generationIssuerRole,
                        privilege: 'EXECUTE',
                        grantable: false
                      }
                    ]
          ) ||
        fn.runtime_execute !== false ||
        fn.public_execute !== false
    )
  ) {
    throw new Error('PostgreSQL restricted authority writer functions are incompatible');
  }
  if (recoveryRole !== undefined) {
    const role = await sql`select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
       has_database_privilege(oid,current_database(),'CREATE') as create_database,
       has_database_privilege(oid,current_database(),'TEMP') as create_temp,
       exists (select 1 from pg_auth_members m where m.member=r.oid or m.roleid=r.oid) as membership
       from pg_roles r where rolname=${recoveryRole}`;
    const row = role[0];
    if (
      role.length !== 1 ||
      row?.rolcanlogin !== true ||
      row.rolsuper !== false ||
      row.rolcreatedb !== false ||
      row.rolcreaterole !== false ||
      row.create_database !== false ||
      row.create_temp !== false ||
      row.membership !== false
    ) {
      throw new Error('PostgreSQL recovery role is not restricted');
    }
    const tables = await sql`select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=${schema} and c.relkind in ('r','p') and (
        has_table_privilege(${recoveryRole},c.oid,'INSERT') or
        has_table_privilege(${recoveryRole},c.oid,'UPDATE') or
        has_table_privilege(${recoveryRole},c.oid,'DELETE') or
        has_table_privilege(${recoveryRole},c.oid,'TRUNCATE') or
        has_table_privilege(${recoveryRole},c.oid,'REFERENCES') or
        has_table_privilege(${recoveryRole},c.oid,'TRIGGER') or
        has_any_column_privilege(${recoveryRole},c.oid,'INSERT') or
        has_any_column_privilege(${recoveryRole},c.oid,'UPDATE') or
        has_any_column_privilege(${recoveryRole},c.oid,'REFERENCES')) limit 1`;
    const schemas = await sql`select 1 from pg_namespace n
       where has_schema_privilege(${recoveryRole},n.oid,'CREATE') limit 1`;
    if (tables.length > 0 || schemas.length > 0) {
      throw new Error('PostgreSQL recovery role has direct authority mutations');
    }
  }
  if (setupRole !== undefined) {
    const membership = await sql`select 1 from pg_auth_members
       where roleid=${setupRole}::regrole::oid or member=${setupRole}::regrole::oid limit 1`;
    if (membership.length > 0) {
      throw new Error('PostgreSQL setup admission role membership is incompatible');
    }
    const directWrites = await sql`select c.relname from pg_class c
       join pg_namespace n on n.oid=c.relnamespace
       where n.nspname=${schema} and c.relkind in ('r','p') and (
         has_table_privilege(${setupRole},c.oid,'INSERT') or
         has_table_privilege(${setupRole},c.oid,'UPDATE') or
          has_table_privilege(${setupRole},c.oid,'DELETE') or
          has_table_privilege(${setupRole},c.oid,'TRUNCATE') or
          has_table_privilege(${setupRole},c.oid,'REFERENCES') or
          has_table_privilege(${setupRole},c.oid,'TRIGGER') or
          has_any_column_privilege(${setupRole},c.oid,'INSERT') or
          has_any_column_privilege(${setupRole},c.oid,'UPDATE') or
          has_any_column_privilege(${setupRole},c.oid,'REFERENCES')) limit 1`;
    if (directWrites.length > 0) {
      throw new Error('PostgreSQL setup admission role has direct table writes');
    }
    const schemaCreate = await sql`select 1 from pg_namespace n
         where has_schema_privilege(${setupRole},n.oid,'CREATE') limit 1`;
    if (schemaCreate.length > 0) {
      throw new Error('PostgreSQL setup admission role has schema CREATE privileges');
    }
  }
  if (writers !== undefined) {
    const membership = await sql`select m.roleid::regrole::text as granted_role,
      m.member::regrole::text as member from pg_auth_members m
      where m.roleid in (${writers.trustAdminRole}::regrole::oid,
        ${writers.generationIssuerRole}::regrole::oid)
        or m.member in (${writers.trustAdminRole}::regrole::oid,
          ${writers.generationIssuerRole}::regrole::oid) limit 1`;
    if (membership.length > 0) {
      throw new Error('PostgreSQL restricted writer role membership is incompatible');
    }
    const directWrites = await sql`select c.relname from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=${schema} and c.relkind in ('r','p') and (
        has_table_privilege(${writers.trustAdminRole},c.oid,'INSERT') or
        has_table_privilege(${writers.trustAdminRole},c.oid,'UPDATE') or
        has_table_privilege(${writers.trustAdminRole},c.oid,'DELETE') or
        has_table_privilege(${writers.trustAdminRole},c.oid,'TRUNCATE') or
        has_table_privilege(${writers.trustAdminRole},c.oid,'REFERENCES') or
        has_table_privilege(${writers.trustAdminRole},c.oid,'TRIGGER') or
        has_any_column_privilege(${writers.trustAdminRole},c.oid,'INSERT') or
        has_any_column_privilege(${writers.trustAdminRole},c.oid,'UPDATE') or
        has_any_column_privilege(${writers.trustAdminRole},c.oid,'REFERENCES') or
        has_table_privilege(${writers.generationIssuerRole},c.oid,'INSERT') or
        has_table_privilege(${writers.generationIssuerRole},c.oid,'UPDATE') or
        has_table_privilege(${writers.generationIssuerRole},c.oid,'DELETE') or
        has_table_privilege(${writers.generationIssuerRole},c.oid,'TRUNCATE') or
        has_table_privilege(${writers.generationIssuerRole},c.oid,'REFERENCES') or
        has_table_privilege(${writers.generationIssuerRole},c.oid,'TRIGGER') or
        has_any_column_privilege(${writers.generationIssuerRole},c.oid,'INSERT') or
        has_any_column_privilege(${writers.generationIssuerRole},c.oid,'UPDATE') or
        has_any_column_privilege(${writers.generationIssuerRole},c.oid,'REFERENCES')) limit 1`;
    if (directWrites.length > 0) {
      throw new Error('PostgreSQL restricted writer has direct table mutation privileges');
    }
  }
};

/** Installer-only operation. Never invoke it from an activity or runtime connection. */
export const migratePostgresAuthoritySchema = async (
  configuration: PostgresEvidenceStoreConfiguration,
  runtimeRole: string,
  targetVersion: PostgresAuthoritySchemaVersion = POSTGRES_AUTHORITY_SCHEMA_VERSION,
  writerRoles?: PostgresAuthorityWriterRoles
): Promise<void> => {
  assertPostgresEvidenceStoreConfiguration(configuration);
  if (!migrations.some((migration) => migration.version === targetVersion)) {
    throw new Error('Unsupported PostgreSQL authority schema target version');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(runtimeRole) || runtimeRole === configuration.role) {
    throw new Error('PostgreSQL migration owner and runtime roles must be distinct identifiers');
  }
  if (
    writerRoles !== undefined &&
    (targetVersion < 8 ||
      targetVersion >= 9 !== (writerRoles.setupAdmissionRole !== undefined) ||
      targetVersion >= 12 !== (writerRoles.recoveryRole !== undefined) ||
      ![
        writerRoles.trustAdminRole,
        writerRoles.generationIssuerRole,
        ...(writerRoles.setupAdmissionRole === undefined ? [] : [writerRoles.setupAdmissionRole]),
        ...(writerRoles.recoveryRole === undefined ? [] : [writerRoles.recoveryRole])
      ].every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      new Set([
        configuration.role,
        runtimeRole,
        writerRoles.trustAdminRole,
        writerRoles.generationIssuerRole,
        ...(writerRoles.setupAdmissionRole === undefined ? [] : [writerRoles.setupAdmissionRole]),
        ...(writerRoles.recoveryRole === undefined ? [] : [writerRoles.recoveryRole])
      ]).size !== (targetVersion >= 12 ? 6 : targetVersion >= 9 ? 5 : 4))
  ) {
    throw new Error('PostgreSQL authority writer roles must be distinct, valid logins on v8');
  }
  const sql = postgres(configuration.connectionString);
  const schema = quote(configuration.schema);
  try {
    await sql.begin(async (tx) => {
      await assertSupportedServerVersion(tx);
      const identity = await tx`select current_user as name`;
      if (identity[0]?.name !== configuration.role) {
        throw new Error('PostgreSQL migration owner role mismatch');
      }
      await tx`select pg_advisory_xact_lock(hashtext(${`forge-schema:${configuration.schema}`}))`;
      const existing = await tx`select 1 from pg_namespace where nspname = ${configuration.schema}`;
      if (existing.length === 0) {
        await tx.unsafe(`create schema ${schema}`);
      }
      const owners =
        await tx`select nspowner::regrole::text as name from pg_namespace where nspname = ${configuration.schema}`;
      if (owners[0]?.name !== configuration.role) {
        throw new Error('PostgreSQL migration role does not own the authority schema');
      }
      const objects =
        await tx`select relname from pg_class where relnamespace = ${configuration.schema}::regnamespace and relkind in ('r','p')`;
      const hasLedger = objects.some((row) => row.relname === 'forge_schema_migrations');
      if (!hasLedger && objects.length !== 0) {
        throw new Error('PostgreSQL authority schema has objects but no migration ledger');
      }
      if (!hasLedger) {
        await tx.unsafe(`create table ${schema}.forge_schema_migrations (
          version integer primary key, checksum text not null,
          applied_at timestamptz not null default now()
        )`);
      }
      const applied = await tx.unsafe(
        `select version, checksum from ${schema}.forge_schema_migrations order by version`
      );
      const installedObjects =
        await tx`select relname from pg_class where relnamespace = ${configuration.schema}::regnamespace and relkind in ('r','p')`;
      const expectedTables =
        applied.length === 0
          ? ['forge_schema_migrations']
          : [
              'forge_schema_migrations',
              'forge_runs',
              'forge_records',
              ...(applied.length >= 3 ? installedGlobalTables(applied.length) : [])
            ];
      if (
        installedObjects.length !== expectedTables.length ||
        expectedTables.some((name) => !installedObjects.some((row) => row.relname === name))
      ) {
        throw new Error('PostgreSQL authority schema has unexpected or missing tables');
      }
      for (let index = 0; index < applied.length; index++) {
        const migration = migrations[index];
        if (
          migration === undefined ||
          applied[index]?.version !== migration.version ||
          applied[index]?.checksum !== checksum(migration.statements)
        ) {
          throw new Error('PostgreSQL authority migration ledger is incompatible');
        }
      }
      if (applied.length > targetVersion) {
        throw new Error('PostgreSQL authority migrations cannot downgrade a schema');
      }
      await assertAuthorityShape(tx, configuration.schema, applied.length);
      if (applied.length >= 3) {
        await assertGlobalAuthorityShape(tx, configuration.schema, applied.length);
      }
      for (const migration of migrations.slice(applied.length, targetVersion)) {
        for (const statement of migration.statements) {
          const qualified = statement.replaceAll('{schema}', schema);
          await tx.unsafe(qualified);
        }
        await tx.unsafe(
          `insert into ${schema}.forge_schema_migrations (version, checksum) values ($1,$2)`,
          [migration.version, checksum(migration.statements)]
        );
      }
      await assertAuthorityShape(tx, configuration.schema, targetVersion);
      if (targetVersion >= 3) {
        await assertGlobalAuthorityShape(tx, configuration.schema, targetVersion);
      }
      await grantRuntimePrivileges(tx, schema, runtimeRole, targetVersion);
      if (targetVersion >= 8) {
        const roleBinding =
          writerRoles === undefined
            ? null
            : JSON.stringify({
                trustAdminRole: writerRoles.trustAdminRole,
                generationIssuerRole: writerRoles.generationIssuerRole
              });
        const previousBindings = await tx`select obj_description(p.oid,'pg_proc') as binding
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname=${configuration.schema} and p.proname in ('forge_trust_write','forge_generation_write')`;
        if (
          previousBindings.length !== 2 ||
          previousBindings.some((row) => row.binding !== null && row.binding !== roleBinding)
        ) {
          throw new Error('PostgreSQL authority writer role binding cannot be changed');
        }
        for (const signature of [
          'forge_trust_write(text,text,text)',
          'forge_generation_write(text,text,text,text,text,text,text,text,text,text,text)',
          ...(targetVersion >= 9 ? [`forge_setup_admit(${Array(21).fill('text').join(',')})`] : []),
          ...(targetVersion >= 10 ? [`forge_setup_arm(${Array(22).fill('text').join(',')})`] : []),
          ...(targetVersion >= 11
            ? [
                `forge_workspace_permit_begin(${Array(26).fill('text').join(',')})`,
                'forge_workspace_permit_finish(text,text,text)'
              ]
            : []),
          ...(targetVersion >= 12
            ? [
                `forge_workspace_recovery_settle(${Array(12).fill('text').join(',')})`,
                `forge_workspace_recovery_handoff(${Array(16).fill('text').join(',')})`
              ]
            : [])
        ]) {
          await tx.unsafe(`revoke all on function ${schema}.${signature} from public`);
          await tx.unsafe(
            `revoke all on function ${schema}.${signature} from ${quote(runtimeRole)}`
          );
        }
        if (targetVersion >= 9 && writerRoles?.setupAdmissionRole !== undefined) {
          const setupRole = writerRoles.setupAdmissionRole;
          const recorded = await tx`select obj_description(p.oid,'pg_proc') as binding
              from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname=${configuration.schema} and p.proname in
                  ('forge_setup_admit', 'forge_setup_arm', 'forge_workspace_permit_begin', 'forge_workspace_permit_finish')`;
          if (
            recorded.length !== (targetVersion >= 11 ? 4 : targetVersion >= 10 ? 2 : 1) ||
            recorded.some((row) => row.binding !== null && row.binding !== setupRole)
          ) {
            throw new Error('PostgreSQL setup admission role binding cannot be changed');
          }
          const principal = await tx`select r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolcanlogin,
             has_database_privilege(r.oid,current_database(),'CREATE') as create_database,
             has_database_privilege(r.oid,current_database(),'TEMP') as create_temp,
             exists (select 1 from pg_auth_members m where m.member=r.oid or m.roleid=r.oid) as membership
             from pg_roles r where r.rolname=${setupRole}`;
          if (
            principal.length !== 1 ||
            principal[0]?.rolsuper !== false ||
            principal[0].rolcreatedb !== false ||
            principal[0].rolcreaterole !== false ||
            principal[0].rolcanlogin !== true ||
            principal[0].create_database !== false ||
            principal[0].create_temp !== false ||
            principal[0].membership !== false
          ) {
            throw new Error('PostgreSQL setup admission role is not restricted');
          }
          const roleName = quote(setupRole);
          const setupFunctions = [
            `forge_setup_admit(${Array(21).fill('text').join(',')})`,
            ...(targetVersion >= 10
              ? [`forge_setup_arm(${Array(22).fill('text').join(',')})`]
              : []),
            ...(targetVersion >= 11
              ? [
                  `forge_workspace_permit_begin(${Array(26).fill('text').join(',')})`,
                  'forge_workspace_permit_finish(text,text,text)'
                ]
              : [])
          ];
          for (const functionName of setupFunctions) {
            await tx.unsafe(`revoke all on function ${schema}.${functionName} from ${roleName}`);
          }
          await tx.unsafe(`revoke all on schema ${schema} from ${roleName}`);
          await tx.unsafe(`grant usage on schema ${schema} to ${roleName}`);
          for (const table of [
            'forge_schema_migrations',
            'forge_runs',
            'forge_records',
            ...installedGlobalTables(targetVersion)
          ]) {
            await tx.unsafe(`revoke all on ${schema}.${table} from ${roleName}`);
          }
          const setupColumnDrift = await tx`select c.relname from pg_class c
            join pg_namespace n on n.oid=c.relnamespace
            join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
            cross join lateral aclexplode(a.attacl) acl
            where n.nspname=${configuration.schema} and c.relkind in ('r','p')
              and acl.grantee=${setupRole}::regrole::oid limit 1`;
          if (setupColumnDrift.length > 0) {
            throw new Error('PostgreSQL authority writer column grants require owner repair');
          }
          await tx.unsafe(`grant select on ${schema}.forge_global_trust_keys to ${roleName}`);
          for (const functionName of setupFunctions) {
            await tx.unsafe(`grant execute on function ${schema}.${functionName} to ${roleName}`);
            await tx.unsafe(`comment on function ${schema}.${functionName} is '${setupRole}'`);
          }
        }
        if (targetVersion >= 12 && writerRoles?.recoveryRole !== undefined) {
          const recoveryRole = writerRoles.recoveryRole;
          const recoveryBindings = await tx`select obj_description(p.oid,'pg_proc') as binding
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname=${configuration.schema} and p.proname in
               ('forge_workspace_recovery_settle','forge_workspace_recovery_handoff')`;
          if (
            recoveryBindings.length !== 2 ||
            recoveryBindings.some((row) => row.binding !== null && row.binding !== recoveryRole)
          ) {
            throw new Error('PostgreSQL recovery role binding cannot be changed');
          }
          const signatures = [
            `forge_workspace_recovery_settle(${Array(12).fill('text').join(',')})`,
            `forge_workspace_recovery_handoff(${Array(16).fill('text').join(',')})`
          ];
          const writer = quote(recoveryRole);
          for (const signature of signatures) {
            await tx.unsafe(`revoke all on function ${schema}.${signature} from ${writer}`);
          }
          await tx.unsafe(`revoke all on schema ${schema} from ${writer}`);
          await tx.unsafe(`grant usage on schema ${schema} to ${writer}`);
          for (const table of [
            'forge_schema_migrations',
            'forge_runs',
            'forge_records',
            ...installedGlobalTables(targetVersion)
          ]) {
            await tx.unsafe(`revoke all on ${schema}.${table} from ${writer}`);
          }
          const columnDrift = await tx`select 1 from pg_class c
             join pg_namespace n on n.oid=c.relnamespace
             join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
             cross join lateral aclexplode(a.attacl) acl
             where n.nspname=${configuration.schema} and c.relkind in ('r','p')
               and acl.grantee=${recoveryRole}::regrole::oid limit 1`;
          if (columnDrift.length > 0) {
            throw new Error('PostgreSQL recovery role column grants require owner repair');
          }
          for (const signature of signatures) {
            await tx.unsafe(`grant execute on function ${schema}.${signature} to ${writer}`);
            await tx.unsafe(`comment on function ${schema}.${signature} is '${recoveryRole}'`);
          }
        }
        if (writerRoles === undefined) {
          const granted = await tx`select proname from pg_proc p
            join pg_namespace n on n.oid=p.pronamespace
            where n.nspname=${configuration.schema}
              and proname in ('forge_trust_write','forge_generation_write')
              and (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                   where a.grantee not in (0,p.proowner,current_user::regrole::oid,${runtimeRole}::regrole::oid)) > 0`;
          if (granted.length > 0) {
            throw new Error('Writer roles must be supplied to repair PostgreSQL function grants');
          }
        }
        if (writerRoles !== undefined) {
          const writerPrincipals = await tx`select r.rolname as name, r.rolsuper, r.rolcreatedb,
            r.rolcreaterole, r.rolcanlogin,
            pg_has_role(r.oid,${configuration.role}::name,'MEMBER') as migration_member,
            pg_has_role(r.oid,${runtimeRole}::name,'MEMBER') as runtime_member,
            has_database_privilege(r.oid,current_database(),'CREATE') as create_database,
            has_database_privilege(r.oid,current_database(),'TEMP') as create_temp
            from pg_roles r where r.rolname in (${writerRoles.trustAdminRole},${writerRoles.generationIssuerRole})`;
          if (
            writerPrincipals.length !== 2 ||
            writerPrincipals.some(
              (entry) =>
                entry.rolsuper !== false ||
                entry.rolcreatedb !== false ||
                entry.rolcreaterole !== false ||
                entry.rolcanlogin !== true ||
                entry.migration_member !== false ||
                entry.runtime_member !== false ||
                entry.create_database !== false ||
                entry.create_temp !== false
            )
          ) {
            throw new Error('PostgreSQL authority writer roles are not restricted');
          }
          for (const writerRole of [writerRoles.trustAdminRole, writerRoles.generationIssuerRole]) {
            for (const signature of [
              'forge_trust_write(text,text,text)',
              'forge_generation_write(text,text,text,text,text,text,text,text,text,text,text)'
            ]) {
              await tx.unsafe(
                `revoke all on function ${schema}.${signature} from ${quote(writerRole)}`
              );
            }
          }
          for (const [roleName, signature] of [
            [writerRoles.trustAdminRole, 'forge_trust_write(text,text,text)'],
            [
              writerRoles.generationIssuerRole,
              'forge_generation_write(text,text,text,text,text,text,text,text,text,text,text)'
            ]
          ]) {
            const writer = quote(roleName);
            await tx.unsafe(`revoke all on schema ${schema} from ${writer}`);
            await tx.unsafe(`grant usage on schema ${schema} to ${writer}`);
            for (const table of [
              'forge_schema_migrations',
              'forge_runs',
              'forge_records',
              ...installedGlobalTables(targetVersion)
            ]) {
              await tx.unsafe(`revoke all on ${schema}.${table} from ${writer}`);
            }
            await tx.unsafe(`grant execute on function ${schema}.${signature} to ${writer}`);
          }
          const columnDrift = await tx`select c.relname from pg_class c
             join pg_namespace n on n.oid=c.relnamespace
             join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
             cross join lateral aclexplode(a.attacl) acl
             where n.nspname=${configuration.schema} and c.relkind in ('r','p')
               and acl.grantee in (${writerRoles.trustAdminRole}::regrole::oid,
                 ${writerRoles.generationIssuerRole}::regrole::oid)
             limit 1`;
          if (columnDrift.length > 0) {
            throw new Error('PostgreSQL authority writer column grants require owner repair');
          }
          for (const signature of [
            'forge_trust_write(text,text,text)',
            'forge_generation_write(text,text,text,text,text,text,text,text,text,text,text)'
          ]) {
            await tx.unsafe(
              `comment on function ${schema}.${signature} is '${roleBinding?.replaceAll("'", "''")}'`
            );
          }
        }
        await assertRestrictedWriterFunctions(tx, configuration.schema, runtimeRole, targetVersion);
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};

const grantRuntimePrivileges = async (
  tx: TransactionSql,
  schema: string,
  runtimeRole: string,
  version: PostgresAuthoritySchemaVersion
): Promise<void> => {
  const role = quote(runtimeRole);
  await tx.unsafe(`revoke all on schema ${schema} from public`);
  await tx.unsafe(`revoke all on schema ${schema} from ${role}`);
  await tx.unsafe(`grant usage on schema ${schema} to ${role}`);
  await tx.unsafe(`revoke all on ${schema}.forge_schema_migrations from public`);
  await tx.unsafe(`revoke all on ${schema}.forge_schema_migrations from ${role}`);
  await tx.unsafe(`grant select on ${schema}.forge_schema_migrations to ${role}`);
  for (const table of ['forge_runs', 'forge_records']) {
    await tx.unsafe(`revoke all on ${schema}.${table} from public`);
    await tx.unsafe(`revoke all on ${schema}.${table} from ${role}`);
  }
  await tx.unsafe(`grant select, insert, update on ${schema}.forge_runs to ${role}`);
  await tx.unsafe(`grant select, insert, update, delete on ${schema}.forge_records to ${role}`);
  if (version >= 3) {
    for (const table of installedGlobalTables(version)) {
      await tx.unsafe(`revoke all on ${schema}.${table} from public`);
      await tx.unsafe(`revoke all on ${schema}.${table} from ${role}`);
      await tx.unsafe(
        `grant ${globalRuntimePrivileges[table].join(', ')} on ${schema}.${table} to ${role}`
      );
    }
  }
};

/** Read-only startup gate: schema installation is exclusively a migration-owner operation. */
export const assertPostgresAuthoritySchema = async (
  sql: Sql,
  configuration: PostgresEvidenceStoreConfiguration,
  requiredVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 = POSTGRES_AUTHORITY_SCHEMA_VERSION
): Promise<void> => {
  assertPostgresAuthorityLogin(configuration);
  if (sql.options.user !== configuration.role) {
    throw new Error('PostgreSQL authority connection login role mismatch');
  }
  await assertSupportedServerVersion(sql);
  const schema = quote(configuration.schema);
  const identity = await sql`select current_user as current_name, session_user as session_name`;
  if (
    identity[0]?.current_name !== configuration.role ||
    identity[0]?.session_name !== configuration.role
  ) {
    throw new Error('PostgreSQL authority role mismatch');
  }
  const metadata =
    await sql`select nspowner::regrole::text as owner from pg_namespace where nspname = ${configuration.schema}`;
  if (metadata.length !== 1 || metadata[0]?.owner === configuration.role) {
    throw new Error('PostgreSQL authority schema does not exist or runtime role owns it');
  }
  const identityPrivileges = await sql`select
    rolsuper, rolcreatedb, rolcreaterole,
    pg_has_role(current_user, ${metadata[0].owner}::name, 'MEMBER') as migration_member,
    exists (select 1 from pg_roles other
      where other.oid <> current_user::regrole
        and pg_has_role(current_user::regrole::oid, other.oid, 'MEMBER')) as other_membership,
    has_database_privilege(current_user, current_database(), 'CREATE') as create_database,
    has_database_privilege(current_user, current_database(), 'TEMP') as create_temp
    from pg_roles where rolname = current_user`;
  if (
    identityPrivileges[0]?.rolsuper !== false ||
    identityPrivileges[0].rolcreatedb !== false ||
    identityPrivileges[0].rolcreaterole !== false ||
    identityPrivileges[0].migration_member !== false ||
    identityPrivileges[0].other_membership !== false ||
    identityPrivileges[0].create_database !== false ||
    identityPrivileges[0].create_temp !== false
  ) {
    throw new Error('PostgreSQL authority runtime role is not least privileged');
  }
  const createSchemas = await sql`select nspname from pg_namespace
    where nspname !~ '^pg_' and nspname <> 'information_schema'
      and has_schema_privilege(current_user, oid, 'CREATE')`;
  if (createSchemas.length > 0) {
    throw new Error('PostgreSQL authority runtime role can create objects in an accessible schema');
  }
  const objects =
    await sql`select relname, relowner::regrole::text as owner from pg_class where relnamespace = ${configuration.schema}::regnamespace and relkind in ('r','p')`;
  for (const name of ['forge_schema_migrations', 'forge_runs', 'forge_records']) {
    const object = objects.find((row) => row.relname === name);
    if (object === undefined || object.owner === configuration.role) {
      throw new Error(`PostgreSQL authority object is missing or runtime-owned: ${name}`);
    }
  }
  const applied = await sql.unsafe(
    `select version, checksum from ${schema}.forge_schema_migrations order by version`
  );
  if (
    applied.length < requiredVersion ||
    applied.length > POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION ||
    applied.some((row, index) => row.version !== index + 1)
  ) {
    throw new Error('PostgreSQL authority schema version is incompatible');
  }
  for (let index = 0; index < applied.length; index++) {
    const migration = migrations[index];
    if (
      migration === undefined ||
      applied[index]?.version !== migration.version ||
      applied[index]?.checksum !== checksum(migration.statements)
    ) {
      throw new Error('PostgreSQL authority migration ledger is incompatible');
    }
  }
  const tables = [
    'forge_schema_migrations',
    'forge_runs',
    'forge_records',
    ...(applied.length >= 3 ? installedGlobalTables(applied.length) : [])
  ];
  for (const name of tables) {
    const object = objects.find((row) => row.relname === name);
    if (object === undefined || object.owner === configuration.role) {
      throw new Error(`PostgreSQL authority object is missing or runtime-owned: ${name}`);
    }
  }
  if (
    objects.length !== tables.length ||
    objects.some((object) => object.owner !== metadata[0]?.owner)
  ) {
    throw new Error('PostgreSQL authority object ownership or table set is incompatible');
  }
  const privileges = await sql`select
    has_schema_privilege(current_user, ${configuration.schema}, 'USAGE') as usage,
    has_schema_privilege(current_user, ${configuration.schema}, 'USAGE WITH GRANT OPTION') as usage_grant,
    has_schema_privilege(current_user, ${configuration.schema}, 'CREATE') as create_schema,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'SELECT') as ledger_read,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'INSERT') as ledger_insert,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'UPDATE') as ledger_update,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'DELETE') as ledger_delete,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'TRUNCATE') as ledger_truncate,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'REFERENCES') as ledger_references,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'TRIGGER') as ledger_trigger,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'SELECT') as runs_select,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'INSERT') as runs_insert,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'UPDATE') as runs_update,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'DELETE') as runs_delete,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'TRUNCATE') as runs_truncate,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'REFERENCES') as runs_references,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'TRIGGER') as runs_trigger,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'SELECT') as records_select,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'INSERT') as records_insert,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'UPDATE') as records_update,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'DELETE') as records_delete,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'TRUNCATE') as records_truncate,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'REFERENCES') as records_references,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'TRIGGER') as records_trigger,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'INSERT') as ledger_column_insert,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'UPDATE') as ledger_column_update,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'REFERENCES') as ledger_column_references,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'REFERENCES') as runs_column_references,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'REFERENCES') as records_column_references,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'SELECT WITH GRANT OPTION') as ledger_grant_select,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'SELECT WITH GRANT OPTION') as runs_grant_select,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'INSERT WITH GRANT OPTION') as runs_grant_insert,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'UPDATE WITH GRANT OPTION') as runs_grant_update,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'SELECT WITH GRANT OPTION') as records_grant_select,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'INSERT WITH GRANT OPTION') as records_grant_insert,
    has_any_column_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'UPDATE WITH GRANT OPTION') as records_grant_update,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'DELETE WITH GRANT OPTION') as records_grant_delete`;
  const p = privileges[0];
  if (
    p?.usage !== true ||
    p.usage_grant !== false ||
    p.create_schema === true ||
    p.ledger_read !== true ||
    p.ledger_insert !== false ||
    p.ledger_update !== false ||
    p.ledger_delete !== false ||
    p.ledger_truncate !== false ||
    p.ledger_references !== false ||
    p.ledger_trigger !== false ||
    p.ledger_column_insert !== false ||
    p.ledger_column_update !== false ||
    p.ledger_column_references !== false ||
    p.ledger_grant_select !== false ||
    p.runs_select !== true ||
    p.runs_insert !== true ||
    p.runs_update !== true ||
    p.runs_delete !== false ||
    p.runs_truncate !== false ||
    p.runs_references !== false ||
    p.runs_trigger !== false ||
    p.runs_column_references !== false ||
    p.runs_grant_select !== false ||
    p.runs_grant_insert !== false ||
    p.runs_grant_update !== false ||
    p.records_select !== true ||
    p.records_insert !== true ||
    p.records_update !== true ||
    p.records_delete !== true ||
    p.records_truncate !== false ||
    p.records_references !== false ||
    p.records_trigger !== false ||
    p.records_column_references !== false ||
    p.records_grant_select !== false ||
    p.records_grant_insert !== false ||
    p.records_grant_update !== false ||
    p.records_grant_delete !== false
  ) {
    throw new Error('PostgreSQL authority runtime privileges are incompatible');
  }
  await assertAuthorityShape(sql, configuration.schema, applied.length);
  if (applied.length >= 8) {
    await assertRestrictedWriterFunctions(
      sql,
      configuration.schema,
      configuration.role,
      applied.length
    );
  }
  if (applied.length >= 3) {
    await assertGlobalAuthorityShape(sql, configuration.schema, applied.length);
    for (const table of installedGlobalTables(applied.length)) {
      const relation = `${configuration.schema}.${table}`;
      const globalPrivileges = await sql`select
        has_table_privilege(current_user, ${relation}, 'SELECT') as read,
        has_table_privilege(current_user, ${relation}, 'INSERT') as insert,
        has_table_privilege(current_user, ${relation}, 'UPDATE') as update,
        has_table_privilege(current_user, ${relation}, 'DELETE') as delete,
        has_table_privilege(current_user, ${relation}, 'TRUNCATE') as truncate,
        has_table_privilege(current_user, ${relation}, 'TRIGGER') as trigger,
        has_table_privilege(current_user, ${relation}, 'REFERENCES') as references,
        has_any_column_privilege(current_user, ${relation}, 'SELECT') as column_read,
        has_any_column_privilege(current_user, ${relation}, 'INSERT') as column_insert,
        has_any_column_privilege(current_user, ${relation}, 'UPDATE') as column_update,
        has_any_column_privilege(current_user, ${relation}, 'REFERENCES') as column_references,
        has_any_column_privilege(current_user, ${relation}, 'SELECT WITH GRANT OPTION') as grant_read,
        has_any_column_privilege(current_user, ${relation}, 'INSERT WITH GRANT OPTION') as grant_insert,
        has_any_column_privilege(current_user, ${relation}, 'UPDATE WITH GRANT OPTION') as grant_update,
        has_table_privilege(current_user, ${relation}, 'DELETE WITH GRANT OPTION') as grant_delete,
        has_table_privilege(current_user, ${relation}, 'TRUNCATE WITH GRANT OPTION') as grant_truncate,
        has_table_privilege(current_user, ${relation}, 'TRIGGER WITH GRANT OPTION') as grant_trigger,
        has_any_column_privilege(current_user, ${relation}, 'REFERENCES WITH GRANT OPTION') as grant_references`;
      const globalPrivilege = globalPrivileges[0];
      const allowed: readonly string[] = globalRuntimePrivileges[table];
      if (
        globalPrivilege?.read !== true ||
        globalPrivilege.insert !== allowed.includes('INSERT') ||
        globalPrivilege.update !== allowed.includes('UPDATE') ||
        globalPrivilege.delete !== allowed.includes('DELETE') ||
        globalPrivilege.truncate !== false ||
        globalPrivilege.trigger !== false ||
        globalPrivilege.references !== false ||
        globalPrivilege.column_read !== allowed.includes('SELECT') ||
        globalPrivilege.column_insert !== allowed.includes('INSERT') ||
        globalPrivilege.column_update !== allowed.includes('UPDATE') ||
        globalPrivilege.column_references !== false ||
        globalPrivilege.grant_read !== false ||
        globalPrivilege.grant_insert !== false ||
        globalPrivilege.grant_update !== false ||
        globalPrivilege.grant_delete !== false ||
        globalPrivilege.grant_truncate !== false ||
        globalPrivilege.grant_trigger !== false ||
        globalPrivilege.grant_references !== false
      ) {
        throw new Error(
          `PostgreSQL global authority runtime privileges are incompatible: ${table}`
        );
      }
      // A table grant masks redundant column grants in has_any_column_privilege.
      // Installation never grants column privileges, so reject even redundant ACL drift.
      const columnGrants = await sql`select exists (
         select 1 from pg_attribute attribute
         cross join lateral aclexplode(attribute.attacl) grant_entry
         where attribute.attrelid = ${relation}::regclass
           and attribute.attnum > 0 and not attribute.attisdropped
           and grant_entry.grantee in (0, current_user::regrole::oid)
       ) as present`;
      if (columnGrants[0]?.present !== false) {
        throw new Error(
          `PostgreSQL global authority runtime privileges are incompatible: ${table}`
        );
      }
    }
  }
};

/** M4.2 runtime gate: the migration owner must install version 8 before connecting. */
export const assertPostgresGlobalAuthoritySchema = async (
  sql: Sql,
  configuration: PostgresEvidenceStoreConfiguration
): Promise<void> =>
  assertPostgresAuthoritySchema(sql, configuration, POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION);
