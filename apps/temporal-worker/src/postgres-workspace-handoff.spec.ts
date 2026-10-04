import { generateKeyPairSync } from 'node:crypto';
import postgres from 'postgres';
import { afterEach, expect, it, vi } from 'vitest';
import { openPostgresConnection } from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { PostgresWorkspaceHandoff } from './postgres-workspace-handoff.js';
import { PostgresWorkspaceRecoveryObserver } from './postgres-workspace-recovery.js';

vi.mock('@ai-native-software-delivery-orchestrator/postgres-persistence', async (original) => ({
  ...(await original<
    typeof import('@ai-native-software-delivery-orchestrator/postgres-persistence')
  >()),
  openPostgresConnection: vi.fn()
}));
afterEach(() => vi.restoreAllMocks());

const unused = async (): Promise<never> => {
  throw new Error('Audit must not inspect workspaces');
};
const configuration = (role: string) => ({
  connectionString: `postgresql://${role}@localhost/fixture`,
  schema: 'forge',
  role
});

const fixture = (major: number, membershipRows: readonly unknown[]) => {
  // Use the real helper and lazy driver's array encoding, intercepting only database I/O.
  const client = postgres('postgresql://recovery@localhost/fixture');
  const statements: string[] = [];
  const end = vi.spyOn(client, 'end');
  const array = vi.spyOn(client, 'array');
  const sql = new Proxy(client, {
    apply(_target, _receiver, args) {
      const chunks: unknown = args[0];
      if (!Array.isArray(chunks) || chunks.some((chunk) => typeof chunk !== 'string')) {
        throw new Error('Expected SQL template');
      }
      const statement = chunks.join('');
      statements.push(statement);
      if (statement.includes('server_version_num')) {
        return Promise.resolve([{ version: major * 10000 }]);
      }
      if (statement.includes('pg_catalog.pg_auth_members')) {
        return Promise.resolve(membershipRows);
      }
      if (statement.includes('session_user')) {
        return Promise.resolve([
          {
            name: 'recovery',
            session_name: 'recovery',
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            membership: true,
            create_database: false,
            create_temp: false
          }
        ]);
      }
      if (statement.includes('from pg_proc')) {
        return Promise.resolve(
          [
            'forge_generation_write',
            'forge_setup_admit',
            'forge_setup_arm',
            'forge_trust_write',
            'forge_workspace_permit_begin',
            'forge_workspace_permit_finish',
            'forge_workspace_recovery_abandon',
            'forge_workspace_recovery_settle',
            'forge_workspace_recovery_handoff'
          ].map((name) => ({
            name,
            designated: 'recovery',
            security_definer: true,
            executable: name.startsWith('forge_workspace_recovery_'),
            grantable: false,
            public_execute: false
          }))
        );
      }
      return Promise.resolve([]);
    }
  });
  vi.mocked(openPostgresConnection).mockReturnValue(sql);
  const observer = new PostgresWorkspaceRecoveryObserver({
    authority: { recoverWorkspaceSetupEvidence: unused },
    issuer: { revoke: unused },
    persistence: { recoverRun: unused },
    supervisor: { stopAndVerify: unused, assertStopped: unused, inspectStoppedWorkspace: unused }
  });
  const { publicKey } = generateKeyPairSync('ed25519');
  const connect = () =>
    PostgresWorkspaceHandoff.connect({
      recovery: configuration('recovery'),
      runtime: configuration('runtime'),
      issuer: configuration('issuer'),
      observer,
      keyId: 'audit',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' })
    });
  return { connect, client, statements, end, array };
};

it.each([16, 17, 18])(
  'uses the accepted membership audit through PG%i handoff connect',
  async (major) => {
    const f = fixture(major, [{ incompatible: false }]);
    try {
      const handoff = await f.connect();
      expect(f.array).toHaveBeenCalledWith(['recovery']);
      expect(f.statements[1]).toContain('datdba');
      expect(f.statements[1]).toContain('m.admin_option is not true');
      expect(f.statements[1]).toContain('m.inherit_option is not false');
      expect(f.statements[1]).toContain('m.set_option is not false');
      await handoff.close();
      expect(f.end).toHaveBeenCalledOnce();
    } finally {
      await f.client.end();
    }
  }
);

it.each([14, 15])(
  'retains strict incoming/outgoing membership rejection through PG%i handoff connect',
  async (major) => {
    const f = fixture(major, [{ incompatible: true }]);
    await expect(f.connect()).rejects.toThrow(
      'PostgreSQL recovery requires its isolated restricted principal'
    );
    expect(f.statements[1]).toContain('m.member');
    expect(f.statements[1]).toContain('m.roleid');
    expect(f.statements[1]).not.toMatch(/admin_option|inherit_option|set_option|datdba/);
    expect(f.end).toHaveBeenCalledOnce();
  }
);

it.each([{ rows: [] }, { rows: [{}] }, { rows: [{ incompatible: null }] }])(
  'rejects unknown membership audit results through handoff connect: %j',
  async ({ rows }) => {
    const f = fixture(18, rows);
    await expect(f.connect()).rejects.toThrow(
      'PostgreSQL recovery requires its isolated restricted principal'
    );
    expect(f.end).toHaveBeenCalledOnce();
  }
);
