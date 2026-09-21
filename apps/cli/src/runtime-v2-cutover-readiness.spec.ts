import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (path: string): string => readFileSync(resolve(workspaceRoot, path), 'utf8');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`Cutover manifest ${name} must be an object`);
  }
  return value;
};

const string = (value: unknown, name: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`Cutover manifest ${name} must be a string`);
  }
  return value;
};

const boolean = (value: unknown, name: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new Error(`Cutover manifest ${name} must be a boolean`);
  }
  return value;
};

const strings = (value: unknown, name: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new Error(`Cutover manifest ${name} must be an array`);
  }
  return value.map((entry, index) => string(entry, `${name}[${index}]`));
};

const manifestSource = record(
  JSON.parse(source('docs/runtime-v2-destructive-cutover-manifest.json')) as unknown,
  'root'
);
const productionRouteSource = record(manifestSource.productionRoute, 'productionRoute');
const manifest = {
  status: string(manifestSource.status, 'status'),
  destructiveChangesPermitted: boolean(
    manifestSource.destructiveChangesPermitted,
    'destructiveChangesPermitted'
  ),
  productionRoute: {
    launch: string(productionRouteSource.launch, 'productionRoute.launch'),
    worker: string(productionRouteSource.worker, 'productionRoute.worker')
  },
  inventory: (() => {
    if (!Array.isArray(manifestSource.inventory)) {
      throw new Error('Cutover manifest inventory must be an array');
    }
    return manifestSource.inventory.map((entry, index) => {
      const item = record(entry, `inventory[${index}]`);
      return {
        path: string(item.path, `inventory[${index}].path`),
        classification: string(item.classification, `inventory[${index}].classification`),
        deleteAfterM312Pass: boolean(
          item.deleteAfterM312Pass,
          `inventory[${index}].deleteAfterM312Pass`
        )
      };
    });
  })(),
  finalCutoverAssertions: strings(manifestSource.finalCutoverAssertions, 'finalCutoverAssertions')
};

describe('Runtime V2 cutover readiness', () => {
  it('keeps the compiled CLI Temporal-only and outside worker composition', () => {
    const cliSource = source('apps/cli/src/app.ts');

    expect(cliSource).toContain('TemporalRunLauncher');
    expect(cliSource).toContain('startForgeRun');
    expect(cliSource).not.toContain('OrchestrationRuntime');
    expect(cliSource).not.toContain('LocalRuntimeStarter');
    expect(cliSource).not.toContain('forge-runtime-composition');
  });

  it('keeps activity composition in the independently deployable worker', () => {
    const workerSource = source('apps/temporal-worker/src/main.ts');

    expect(workerSource).toContain('createForgeWorkerComposition');
    expect(workerSource).toContain('createTemporalWorker');
    expect(workerSource).not.toContain('OrchestrationRuntime');
    expect(workerSource).not.toContain('LocalRuntimeStarter');
  });

  it('records a non-destructive inventory and all final cutover assertions', () => {
    expect(manifest.status).toBe('CUTOVER_READY_BLOCKED_ON_M3_12_REAL_SMOKE');
    expect(manifest.destructiveChangesPermitted).toBe(false);
    expect(manifest.productionRoute.launch).toContain('TemporalRunLauncher');
    expect(manifest.productionRoute.worker).toBe('apps/temporal-worker/src/main.ts');
    expect(manifest.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'libs/orchestration-runtime/src/lib/orchestration-runtime.ts',
          classification: 'differential-only',
          deleteAfterM312Pass: true
        }),
        expect.objectContaining({
          path: 'libs/run-preparation/src/lib/local-runtime-starter.ts',
          classification: 'differential-only',
          deleteAfterM312Pass: true
        }),
        expect.objectContaining({
          path: 'apps/temporal-worker/src/legacy-temporal-differential.spec.ts',
          classification: 'differential-only',
          deleteAfterM312Pass: true
        }),
        expect.objectContaining({
          path: 'libs/temporal-spike',
          classification: 'frozen-prototype',
          deleteAfterM312Pass: true
        }),
        expect.objectContaining({
          path: 'libs/restate-spike',
          classification: 'frozen-prototype',
          deleteAfterM312Pass: true
        }),
        expect.objectContaining({
          path: 'libs/runtime-v2-spike-harness',
          classification: 'test-only',
          deleteAfterM312Pass: true
        }),
        expect.objectContaining({
          path: 'libs/orchestration-runtime/src/lib',
          classification: 'reusable-application-service',
          deleteAfterM312Pass: false
        })
      ])
    );
    for (const entry of manifest.inventory) {
      expect(existsSync(resolve(workspaceRoot, entry.path))).toBe(true);
    }
    expect(manifest.finalCutoverAssertions).toHaveLength(8);
  });
});
