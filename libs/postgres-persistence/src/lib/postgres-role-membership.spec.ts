import postgres from 'postgres';
import { expect, it } from 'vitest';

import { assertRestrictedPostgresRoleMemberships } from './postgres-role-membership.js';

const auditClient = (rows: readonly unknown[]) => {
  // Keep real lazy client types/array encoding, intercept queries without a socket.
  const client = postgres('postgresql://runtime@localhost/fixture');
  const statements: string[] = [];
  const sql = new Proxy(client, {
    apply(_target, _receiver, argumentsList) {
      const chunks: unknown = argumentsList[0];
      if (!Array.isArray(chunks) || chunks.some((chunk) => typeof chunk !== 'string')) {
        throw new Error('Expected SQL template');
      }
      statements.push(chunks.join(''));
      return Promise.resolve(rows);
    }
  });
  return { client, sql, statements };
};

it.each([14, 15])(
  'retains strict PG%i membership checks without newer catalog columns',
  async (major) => {
    const { client, sql, statements } = auditClient([{ incompatible: true }]);
    try {
      await expect(
        assertRestrictedPostgresRoleMemberships(sql, ['runtime'], 'Rejected membership', major)
      ).rejects.toThrow('Rejected membership');
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain('m.member');
      expect(statements[0]).toContain('m.roleid');
      expect(statements[0]).not.toMatch(/admin_option|inherit_option|set_option|datdba/);
    } finally {
      await client.end();
    }
  }
);

it.each([{ rows: [] }, { rows: [{}] }, { rows: [{ incompatible: null }] }])(
  'rejects an absent or unknown audit result %j',
  async ({ rows }) => {
    const { client, sql } = auditClient(rows);
    try {
      await expect(
        assertRestrictedPostgresRoleMemberships(sql, ['runtime'], 'Rejected membership', 16)
      ).rejects.toThrow('Rejected membership');
    } finally {
      await client.end();
    }
  }
);
