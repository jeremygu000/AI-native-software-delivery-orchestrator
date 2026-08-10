import type {
  WritableResource,
  WriteLeaseRequest
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { InMemoryWriteGuard, WriteGuardInputError } from './in-memory-write-guard.js';

const project = (projectId: string): WritableResource => ({ type: 'project', projectId });
const file = (projectId: string, fileId: string): WritableResource => ({
  type: 'file',
  projectId,
  fileId
});
const symbol = (symbolId: string, ancestorSymbolIds: readonly string[] = []): WritableResource => ({
  type: 'symbol',
  projectId: 'catalog',
  fileId: 'product.ts',
  symbolId,
  ancestorSymbolIds
});

const request = (overrides: Partial<WriteLeaseRequest> = {}): WriteLeaseRequest => ({
  runId: 'run-1',
  agentId: 'agent-1',
  taskId: 'task-1',
  resource: file('catalog', 'product.ts'),
  mode: 'exclusive',
  ...overrides
});

const createGuard = () => {
  let tick = 0;
  return new InMemoryWriteGuard({
    now: () => new Date(`2026-08-10T00:00:0${tick++}.000Z`)
  });
};

describe('InMemoryWriteGuard', () => {
  it('grants an exclusive lease with a stable lifecycle record', async () => {
    const guard = createGuard();

    await expect(guard.acquire(request())).resolves.toEqual({
      status: 'granted',
      lease: {
        id: 'lease-1',
        runId: 'run-1',
        agentId: 'agent-1',
        taskId: 'task-1',
        resource: file('catalog', 'product.ts'),
        mode: 'exclusive',
        version: 1,
        state: 'ACTIVE',
        acquiredAt: new Date('2026-08-10T00:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-08-10T00:00:00.000Z')
      }
    });
  });

  it('makes duplicate acquisition idempotent only for the same run, agent, task, and resource', async () => {
    const guard = createGuard();
    const first = await guard.acquire(request());
    const retry = await guard.acquire(request());
    const differentAgent = await guard.acquire(request({ agentId: 'agent-2' }));

    expect(first).toMatchObject({ status: 'granted', lease: { id: 'lease-1' } });
    expect(retry).toEqual(first);
    expect(differentAgent).toEqual({ status: 'blocked', conflictingLeaseIds: ['lease-1'] });
  });

  it('copies mutable caller resource identity before granting a lease', async () => {
    const guard = createGuard();
    const ancestors = ['ProductService'];
    const resource = symbol('ProductService.search', ancestors);
    const acquired = await guard.acquire(request({ resource }));
    ancestors.push('mutated');
    const retry = await guard.acquire(
      request({ resource: symbol('ProductService.search', ['ProductService']) })
    );

    expect(retry).toMatchObject({
      status: 'granted',
      lease: { id: 'lease-1', resource: symbol('ProductService.search', ['ProductService']) }
    });
    expect(acquired).toMatchObject({ status: 'granted', lease: { id: 'lease-1' } });
  });

  it('treats equivalent symbol ancestor collections as the same idempotent resource', async () => {
    const guard = createGuard();
    const first = await guard.acquire(
      request({ resource: symbol('Service.method', ['Service', 'Namespace']) })
    );
    const retry = await guard.acquire(
      request({ resource: symbol('Service.method', ['Namespace', 'Service']) })
    );

    expect(first).toMatchObject({ status: 'granted', lease: { id: 'lease-1' } });
    expect(retry).toEqual(first);
  });

  it('does not treat a broader lease and contained resource as the same retry identity', async () => {
    const guard = createGuard();
    await guard.acquire(request({ resource: project('catalog') }));

    await expect(
      guard.acquire(request({ resource: file('catalog', 'product.ts') }))
    ).resolves.toEqual({
      status: 'blocked',
      conflictingLeaseIds: ['lease-1']
    });
  });

  it.each([
    [project('catalog'), { type: 'shared-resource', resourceId: 'project-lock' } as const],
    [file('catalog', 'product.ts'), { type: 'shared-resource', resourceId: 'file-lock' } as const],
    [
      symbol('ProductService.search', ['ProductService']),
      { type: 'shared-resource', resourceId: 'symbol-lock' } as const
    ],
    [{ type: 'shared-resource', resourceId: 'shared-lock' } as const, project('catalog')]
  ])(
    'keeps retry identity comparison type-safe across resource kinds',
    async (firstResource, secondResource) => {
      const guard = createGuard();

      await expect(guard.acquire(request({ resource: firstResource }))).resolves.toMatchObject({
        status: 'granted'
      });
      await expect(guard.acquire(request({ resource: secondResource }))).resolves.toMatchObject({
        status: 'granted'
      });
    }
  );

  it.each([
    [project('catalog'), file('catalog', 'product.ts')],
    [file('catalog', 'product.ts'), symbol('ProductService.search', ['ProductService'])],
    [symbol('ProductService'), symbol('ProductService.search', ['ProductService'])],
    [
      { type: 'shared-resource', resourceId: 'graphql-schema' } as const,
      { type: 'shared-resource', resourceId: 'graphql-schema' } as const
    ]
  ])('blocks overlapping hierarchy resources', async (firstResource, secondResource) => {
    const guard = createGuard();
    const first = await guard.acquire(request({ resource: firstResource }));
    const second = await guard.acquire(
      request({ agentId: 'agent-2', taskId: 'task-2', resource: secondResource })
    );

    expect(first).toMatchObject({ status: 'granted', lease: { id: 'lease-1' } });
    expect(second).toEqual({ status: 'blocked', conflictingLeaseIds: ['lease-1'] });
  });

  it('allows sibling symbols, independent files, and distinct shared resources', async () => {
    const guard = createGuard();
    const results = await Promise.all([
      guard.acquire(request({ resource: symbol('ProductService.search', ['ProductService']) })),
      guard.acquire(
        request({
          agentId: 'agent-2',
          taskId: 'task-2',
          resource: symbol('ProductService.get', ['ProductService'])
        })
      ),
      guard.acquire(
        request({
          agentId: 'agent-3',
          taskId: 'task-3',
          resource: { type: 'shared-resource', resourceId: 'graphql-schema' }
        })
      ),
      guard.acquire(
        request({
          agentId: 'agent-4',
          taskId: 'task-4',
          resource: { type: 'shared-resource', resourceId: 'npm-dependencies' }
        })
      )
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'granted',
      'granted',
      'granted',
      'granted'
    ]);
  });

  it('serializes simultaneous acquisition so only one conflicting request is granted', async () => {
    const guard = createGuard();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        guard.acquire(request({ agentId: `agent-${index}`, taskId: `task-${index}` }))
      )
    );

    expect(results.filter((result) => result.status === 'granted')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'blocked')).toHaveLength(19);
    expect(
      results
        .filter((result) => result.status === 'blocked')
        .every((result) => result.conflictingLeaseIds.length === 1)
    ).toBe(true);
  });

  it('reports every independently active conflicting lease in stable order', async () => {
    const guard = createGuard();
    await guard.acquire(request({ resource: file('catalog', 'product.ts') }));
    await guard.acquire(
      request({ agentId: 'agent-2', taskId: 'task-2', resource: file('catalog', 'price.ts') })
    );

    await expect(
      guard.acquire(request({ agentId: 'agent-3', taskId: 'task-3', resource: project('catalog') }))
    ).resolves.toEqual({ status: 'blocked', conflictingLeaseIds: ['lease-1', 'lease-2'] });
  });

  it('updates a heartbeat only with the active lease version', async () => {
    const guard = createGuard();
    const acquired = await guard.acquire(request());
    if (acquired.status !== 'granted') {
      throw new Error('Expected granted lease');
    }

    const active = await guard.heartbeat({ leaseId: acquired.lease.id, expectedVersion: 1 });
    const staleVersion = await guard.heartbeat({ leaseId: acquired.lease.id, expectedVersion: 1 });

    expect(active).toMatchObject({
      status: 'active',
      lease: { version: 2, lastHeartbeatAt: new Date('2026-08-10T00:00:01.000Z') }
    });
    expect(staleVersion).toEqual({ status: 'version-conflict', actualVersion: 2 });
  });

  it('requires evidence and current version to mark a lease stale, then permits replacement', async () => {
    const guard = createGuard();
    const acquired = await guard.acquire(request());
    if (acquired.status !== 'granted') {
      throw new Error('Expected granted lease');
    }

    await expect(
      guard.markStale({ leaseId: acquired.lease.id, expectedVersion: 1, evidence: ' ' })
    ).rejects.toThrow(WriteGuardInputError);
    expect(
      await guard.markStale({
        leaseId: acquired.lease.id,
        expectedVersion: 1,
        evidence: 'Agent exited and workspace is unchanged'
      })
    ).toMatchObject({
      status: 'stale',
      lease: {
        state: 'STALE',
        version: 2,
        staleEvidence: 'Agent exited and workspace is unchanged',
        staleDetectedAt: new Date('2026-08-10T00:00:01.000Z')
      }
    });
    expect(await guard.acquire(request({ agentId: 'agent-2', taskId: 'task-2' }))).toMatchObject({
      status: 'granted',
      lease: { id: 'lease-2' }
    });
    expect(
      await guard.markStale({
        leaseId: acquired.lease.id,
        expectedVersion: 2,
        evidence: 'Repeated recovery attempt'
      })
    ).toEqual({ status: 'not-found' });
    expect(await guard.release({ leaseId: acquired.lease.id, expectedVersion: 2 })).toEqual({
      status: 'not-found'
    });
  });

  it('returns version conflict or not-found for obsolete lifecycle requests', async () => {
    const guard = createGuard();
    const acquired = await guard.acquire(request());
    if (acquired.status !== 'granted') {
      throw new Error('Expected granted lease');
    }

    await guard.heartbeat({ leaseId: acquired.lease.id, expectedVersion: 1 });
    expect(
      await guard.markStale({
        leaseId: acquired.lease.id,
        expectedVersion: 1,
        evidence: 'worker lost'
      })
    ).toEqual({ status: 'version-conflict', actualVersion: 2 });
    expect(await guard.heartbeat({ leaseId: 'missing', expectedVersion: 1 })).toEqual({
      status: 'not-found'
    });
    expect(
      await guard.markStale({ leaseId: 'missing', expectedVersion: 1, evidence: 'worker lost' })
    ).toEqual({ status: 'not-found' });
  });

  it('releases active leases once and makes release idempotent', async () => {
    const guard = createGuard();
    const acquired = await guard.acquire(request());
    if (acquired.status !== 'granted') {
      throw new Error('Expected granted lease');
    }

    expect(await guard.release({ leaseId: acquired.lease.id, expectedVersion: 1 })).toMatchObject({
      status: 'released',
      lease: { version: 2, state: 'RELEASED', releasedAt: new Date('2026-08-10T00:00:01.000Z') }
    });
    expect(await guard.release({ leaseId: acquired.lease.id, expectedVersion: 2 })).toEqual({
      status: 'not-found'
    });
    expect(await guard.heartbeat({ leaseId: acquired.lease.id, expectedVersion: 2 })).toEqual({
      status: 'not-found'
    });
    expect(await guard.acquire(request({ agentId: 'agent-2', taskId: 'task-2' }))).toMatchObject({
      status: 'granted',
      lease: { id: 'lease-2' }
    });
  });

  it('rejects a stale release version without changing an active lease', async () => {
    const guard = createGuard();
    const acquired = await guard.acquire(request());
    if (acquired.status !== 'granted') {
      throw new Error('Expected granted lease');
    }

    await guard.heartbeat({ leaseId: acquired.lease.id, expectedVersion: 1 });
    expect(await guard.release({ leaseId: acquired.lease.id, expectedVersion: 1 })).toEqual({
      status: 'version-conflict',
      actualVersion: 2
    });
    expect(await guard.heartbeat({ leaseId: acquired.lease.id, expectedVersion: 2 })).toMatchObject(
      {
        status: 'active',
        lease: { version: 3 }
      }
    );
  });

  it('fences a release whose expected version becomes stale behind a heartbeat', async () => {
    const guard = createGuard();
    const acquired = await guard.acquire(request());
    if (acquired.status !== 'granted') {
      throw new Error('Expected granted lease');
    }

    const [heartbeat, release] = await Promise.all([
      guard.heartbeat({ leaseId: acquired.lease.id, expectedVersion: 1 }),
      guard.release({ leaseId: acquired.lease.id, expectedVersion: 1 })
    ]);

    expect(heartbeat).toMatchObject({ status: 'active', lease: { version: 2 } });
    expect(release).toEqual({ status: 'version-conflict', actualVersion: 2 });
    expect(await guard.release({ leaseId: acquired.lease.id, expectedVersion: 2 })).toMatchObject({
      status: 'released',
      lease: { version: 3 }
    });
  });

  it('rejects malformed requests and duplicate generated lease IDs', async () => {
    const guard = new InMemoryWriteGuard({ createLeaseId: () => 'same-id' });

    await expect(guard.acquire(request({ runId: ' ' }))).rejects.toThrow(WriteGuardInputError);
    await expect(
      guard.acquire(
        request({ resource: symbol('ProductService.search', ['ProductService', 'ProductService']) })
      )
    ).rejects.toThrow(WriteGuardInputError);
    await expect(
      guard.acquire(
        request({ resource: symbol('ProductService.search', ['ProductService.search']) })
      )
    ).rejects.toThrow('ancestorSymbolIds cannot include symbolId');
    await expect(
      guard.acquire(request({ resource: symbol('ProductService.search', [' ']) }))
    ).rejects.toThrow('ancestorSymbolId must not be empty');
    await expect(guard.heartbeat({ leaseId: 'missing', expectedVersion: 0 })).rejects.toThrow(
      'expectedVersion must be a positive integer'
    );
    await expect(
      guard.heartbeat({ leaseId: 'missing', expectedVersion: Number.NaN })
    ).rejects.toThrow('expectedVersion must be a positive integer');
    await expect(guard.release({ leaseId: 'missing', expectedVersion: 0 })).rejects.toThrow(
      'expectedVersion must be a positive integer'
    );
    await guard.acquire(request());
    await expect(guard.acquire(request({ resource: file('catalog', 'price.ts') }))).rejects.toThrow(
      'Duplicate lease ID: same-id'
    );
  });
});
