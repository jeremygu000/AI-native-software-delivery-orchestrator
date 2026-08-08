import { describe, expect, it } from 'vitest';

import { taskContractSchema } from './task-contract.js';

const validTask = {
  id: 'T1',
  title: 'Add domain support',
  goal: 'Create the Product domain model',
  dependencies: [],
  expectedReads: [{ type: 'project', value: 'catalog-domain' }],
  expectedWrites: [{ type: 'symbol', value: 'catalog-domain:src/product.ts:Product' }],
  sharedResources: [],
  verification: [{ type: 'nx-target', project: 'catalog-domain', target: 'test' }]
} as const;

describe('taskContractSchema', () => {
  it('parses a valid task contract', () => {
    expect(taskContractSchema.parse(validTask)).toEqual(validTask);
  });

  it('rejects a self dependency', () => {
    const result = taskContractSchema.safeParse({ ...validTask, dependencies: ['T1'] });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate dependencies', () => {
    const result = taskContractSchema.safeParse({ ...validTask, dependencies: ['T0', 'T0'] });

    expect(result.success).toBe(false);
  });
});
