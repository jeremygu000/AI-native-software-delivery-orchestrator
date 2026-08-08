import { describe, expect, it } from 'vitest';

import { areWritableResourcesConflicting, type WritableResource } from './write-lease.js';

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
