import { describe, expect, it } from 'vitest';

import {
  areWritableResourcesConflicting,
  type WritableResource,
  type WriteLease,
  writableResourceSchema,
  writeLeaseSchema
} from './write-lease.js';

const project = (projectId: string): WritableResource => ({ type: 'project', projectId });
const file = (projectId: string, fileId: string): WritableResource => ({
  type: 'file',
  projectId,
  fileId
});
const symbol = (
  projectId: string,
  fileId: string,
  symbolId: string,
  ancestorSymbolIds: readonly string[] = []
): WritableResource => ({ type: 'symbol', projectId, fileId, symbolId, ancestorSymbolIds });

describe('areWritableResourcesConflicting', () => {
  it.each([
    [project('catalog'), file('catalog', 'product.ts')],
    [project('catalog'), symbol('catalog', 'product.ts', 'ProductService.search')],
    [file('catalog', 'product.ts'), symbol('catalog', 'product.ts', 'ProductService.search')],
    [
      symbol('catalog', 'product.ts', 'ProductService.search', ['ProductService']),
      symbol('catalog', 'product.ts', 'ProductService.search', ['ProductService'])
    ],
    [
      symbol('catalog', 'product.ts', 'ProductService'),
      symbol('catalog', 'product.ts', 'ProductService.search', ['ProductService'])
    ],
    [
      { type: 'shared-resource', resourceId: 'graphql-schema' } as const,
      { type: 'shared-resource', resourceId: 'graphql-schema' } as const
    ]
  ])('detects containment or identity conflicts', (a, b) => {
    expect(areWritableResourcesConflicting(a, b)).toBe(true);
    expect(areWritableResourcesConflicting(b, a)).toBe(true);
  });

  it.each([
    [project('catalog'), file('search', 'search.ts')],
    [file('catalog', 'product.ts'), file('catalog', 'price.ts')],
    [
      symbol('catalog', 'product.ts', 'ProductService.search', ['ProductService']),
      symbol('catalog', 'product.ts', 'ProductService.get', ['ProductService'])
    ],
    [
      { type: 'shared-resource', resourceId: 'graphql-schema' } as const,
      { type: 'shared-resource', resourceId: 'npm-dependencies' } as const
    ],
    [project('catalog'), { type: 'shared-resource', resourceId: 'catalog' } as const]
  ])('allows independent resources', (a, b) => {
    expect(areWritableResourcesConflicting(a, b)).toBe(false);
    expect(areWritableResourcesConflicting(b, a)).toBe(false);
  });
});

describe('WriteLease contract', () => {
  it('retains evidence used to mark a lease stale', () => {
    const lease: WriteLease = {
      id: 'lease-1',
      runId: 'run-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      resource: file('catalog', 'product.ts'),
      mode: 'exclusive',
      version: 2,
      state: 'STALE',
      acquiredAt: new Date('2026-08-10T00:00:00.000Z'),
      lastHeartbeatAt: new Date('2026-08-10T00:01:00.000Z'),
      staleDetectedAt: new Date('2026-08-10T00:02:00.000Z'),
      staleEvidence: 'Agent process exited and workspace is unchanged'
    };

    expect(lease.staleEvidence).toContain('Agent process exited');
  });

  it('validates complete lease and writable resource recovery records', () => {
    const lease = {
      id: 'lease-1',
      runId: 'run-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      resource: file('catalog', 'product.ts'),
      mode: 'exclusive',
      version: 1,
      state: 'ACTIVE',
      acquiredAt: new Date('2026-08-11T00:00:00.000Z'),
      lastHeartbeatAt: new Date('2026-08-11T00:00:00.000Z')
    } as const;

    expect(writeLeaseSchema.safeParse(lease).success).toBe(true);
    expect(writeLeaseSchema.safeParse({ ...lease, mode: 'shared' }).success).toBe(false);
    expect(writableResourceSchema.safeParse({ projectId: 'catalog' }).success).toBe(false);
  });
});
