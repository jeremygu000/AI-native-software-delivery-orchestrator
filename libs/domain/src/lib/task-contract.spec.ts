import { describe, expect, it } from 'vitest';

import {
  collectSharedResourceIds,
  taskContractSchema,
  taskSpecificationSchema
} from './task-contract.js';

const validTask = {
  id: 'T1',
  title: 'Add domain support',
  goal: 'Create the Product domain model',
  dependencies: [],
  expectedReads: [{ type: 'project', value: 'catalog-domain' }],
  expectedWrites: [{ type: 'symbol', value: 'catalog-domain:src/product.ts:Product' }],
  sharedResources: [],
  verification: [{ type: 'command', command: 'pnpm test' }]
} as const;

describe('taskContractSchema', () => {
  it('parses a valid task contract', () => {
    expect(taskContractSchema.parse(validTask)).toEqual(validTask);
  });

  it('supports repository commands and package scripts as verification rules', () => {
    const verification = [
      { type: 'command', command: 'pnpm test', cwd: 'fixtures/demo' },
      { type: 'package-script', packageName: '@fixture/api', script: 'test' }
    ] as const;

    expect(taskContractSchema.parse({ ...validTask, verification }).verification).toEqual(
      verification
    );
  });

  it('rejects a self dependency', () => {
    const result = taskContractSchema.safeParse({ ...validTask, dependencies: ['T1'] });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate dependencies', () => {
    const result = taskContractSchema.safeParse({ ...validTask, dependencies: ['T0', 'T0'] });

    expect(result.success).toBe(false);
  });

  it('normalizes explicit shared-resource coordination declarations', () => {
    const parsed = taskContractSchema.parse({
      ...validTask,
      sharedResources: ['npm-dependencies', 'graphql-schema', 'npm-dependencies']
    });

    expect(parsed.sharedResources).toEqual(['graphql-schema', 'npm-dependencies']);
  });

  it('collects and deduplicates shared resources from coordination and impact declarations', () => {
    const parsed = taskContractSchema.parse({
      ...validTask,
      expectedReads: [{ type: 'shared-resource', value: 'generated-code' }],
      expectedWrites: [{ type: 'shared-resource', value: 'graphql-schema' }],
      sharedResources: ['graphql-schema', 'npm-dependencies']
    });

    expect(collectSharedResourceIds(parsed)).toEqual([
      'generated-code',
      'graphql-schema',
      'npm-dependencies'
    ]);
  });

  it('ignores ordinary read and write selectors when collecting shared resources', () => {
    const parsed = taskContractSchema.parse(validTask);

    expect(collectSharedResourceIds(parsed)).toEqual([]);
  });

  it('rejects duplicate task IDs at the specification boundary', () => {
    expect(
      taskSpecificationSchema.safeParse({ tasks: [validTask, { ...validTask }] }).success
    ).toBe(false);
  });
});
