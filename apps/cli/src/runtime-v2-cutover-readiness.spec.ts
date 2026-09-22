import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (path: string): string => readFileSync(resolve(workspaceRoot, path), 'utf8');

const typescriptFiles = (path: string): readonly string[] =>
  readdirSync(resolve(workspaceRoot, path), { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = `${path}/${entry.name}`;
      if (entry.isDirectory() && (entry.name === 'dist' || entry.name === 'node_modules')) {
        return [];
      }
      return entry.isDirectory()
        ? typescriptFiles(entryPath)
        : entry.isFile() && entry.name.endsWith('.ts')
          ? [entryPath]
          : [];
    })
    .toSorted();

const packageImports = (path: string, specifier: string): boolean =>
  new RegExp(`from\\s+['"]${specifier}['"]`).test(source(path));

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

const dependencyNames = (value: unknown, name: string): readonly string[] =>
  Object.keys(record(value, name));

const manifestSource = record(
  JSON.parse(source('docs/runtime-v2-destructive-cutover-manifest.json')),
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
        id: string(item.id, `inventory[${index}].id`),
        path: string(item.path, `inventory[${index}].path`),
        classification: string(item.classification, `inventory[${index}].classification`),
        callers: strings(item.callers, `inventory[${index}].callers`),
        deleteAfterM312Pass: boolean(
          item.deleteAfterM312Pass,
          `inventory[${index}].deleteAfterM312Pass`
        ),
        keep: item.keep === undefined ? [] : strings(item.keep, `inventory[${index}].keep`)
      };
    });
  })(),
  blockers: strings(manifestSource.blockers, 'blockers'),
  m312ExternalSmoke: record(manifestSource.m312ExternalSmoke, 'm312ExternalSmoke'),
  finalCutoverAssertions: strings(manifestSource.finalCutoverAssertions, 'finalCutoverAssertions')
};

const inventory = (id: string) => {
  const item = manifest.inventory.find((candidate) => candidate.id === id);
  if (item === undefined) {
    throw new Error(`Cutover manifest inventory is missing ${id}`);
  }
  return item;
};

describe('Runtime V2 cutover readiness', () => {
  it('keeps production package roots outside the legacy module graph', () => {
    const cliSource = source('apps/cli/src/app.ts');
    const runPreparationEntry = source('libs/run-preparation/src/index.ts');
    const orchestrationEntry = source('libs/orchestration-runtime/src/index.ts');
    const cliPackage = record(JSON.parse(source('apps/cli/package.json')), 'CLI package');

    expect(cliSource).toContain('TemporalRunLauncher');
    expect(cliSource).toContain('startForgeRun');
    expect(
      packageImports(
        'apps/cli/src/app.ts',
        '@ai-native-software-delivery-orchestrator/run-preparation'
      )
    ).toBe(true);
    expect(
      packageImports(
        'apps/cli/src/app.ts',
        '@ai-native-software-delivery-orchestrator/orchestration-runtime'
      )
    ).toBe(true);
    expect(runPreparationEntry).not.toContain('local-runtime-starter');
    expect(orchestrationEntry).not.toContain('orchestration-runtime.js');
    expect(orchestrationEntry).not.toContain('durable-execution-spike-contract');
    expect(dependencyNames(cliPackage.dependencies, 'CLI package.dependencies')).not.toContain(
      '@ai-native-software-delivery-orchestrator/temporal-spike'
    );
    expect(dependencyNames(cliPackage.dependencies, 'CLI package.dependencies')).not.toContain(
      '@ai-native-software-delivery-orchestrator/restate-spike'
    );
    expect(dependencyNames(cliPackage.dependencies, 'CLI package.dependencies')).not.toContain(
      '@ai-native-software-delivery-orchestrator/runtime-v2-spike-harness'
    );
  });

  it('keeps activity composition in the independently deployable worker', () => {
    const workerSource = source('apps/temporal-worker/src/main.ts');

    expect(workerSource).toContain('createForgeWorkerComposition');
    expect(workerSource).toContain('createTemporalWorker');
    expect(
      packageImports(
        'apps/temporal-worker/src/main.ts',
        '@ai-native-software-delivery-orchestrator/run-preparation/legacy'
      )
    ).toBe(false);
    expect(
      packageImports(
        'apps/temporal-worker/src/main.ts',
        '@ai-native-software-delivery-orchestrator/orchestration-runtime/legacy'
      )
    ).toBe(false);
  });

  it('confines explicit legacy entries to differential and prototype evidence', () => {
    const runtimeLegacyConsumers = typescriptFiles('apps')
      .concat(typescriptFiles('libs'))
      .filter((path) =>
        packageImports(
          path,
          '@ai-native-software-delivery-orchestrator/orchestration-runtime/legacy'
        )
      );

    expect(runtimeLegacyConsumers).toEqual([
      'apps/temporal-worker/src/legacy-temporal-differential.spec.ts',
      'libs/restate-spike/src/lib/restate-spike-activities.ts',
      'libs/restate-spike/src/lib/shared-harness.ts',
      'libs/run-preparation/src/lib/local-runtime-starter.ts',
      'libs/runtime-v2-spike-harness/src/forge-scenario-service.ts',
      'libs/runtime-v2-spike-harness/src/sqlite-outcome-collector.ts',
      'libs/runtime-v2-spike-harness/tests/restate-real-authority.spec.ts',
      'libs/runtime-v2-spike-harness/tests/temporal-real-authority.spec.ts',
      'libs/temporal-spike/src/lib/outcome-collector.ts',
      'libs/temporal-spike/src/lib/shared-harness.ts',
      'libs/temporal-spike/src/lib/stub-scenario-service.ts',
      'libs/temporal-spike/src/lib/temporal-spike-activities.spec.ts',
      'libs/temporal-spike/src/lib/temporal-spike-activities.ts',
      'libs/temporal-spike/src/lib/temporal-spike-worker.ts',
      'libs/temporal-spike/src/lib/temporal-spike-workflow.spec.ts'
    ]);
  });

  it('records a non-destructive inventory and exact final cutover assertions', () => {
    expect(manifest.status).toBe(
      'CUTOVER_READY_M3_12_REAL_SMOKE_PASS_AWAITING_DESTRUCTIVE_STAGE_REVIEW'
    );
    expect(manifest.destructiveChangesPermitted).toBe(false);
    expect(manifest.productionRoute.launch).toContain('TemporalRunLauncher');
    expect(manifest.productionRoute.worker).toBe('apps/temporal-worker/src/main.ts');
    expect(inventory('legacy-in-process-runtime')).toMatchObject({
      path: 'libs/orchestration-runtime/src/lib/orchestration-runtime.ts',
      classification: 'differential-only',
      callers: ['libs/orchestration-runtime/src/legacy.ts'],
      deleteAfterM312Pass: true
    });
    expect(inventory('local-runtime-starter')).toMatchObject({
      path: 'libs/run-preparation/src/lib/local-runtime-starter.ts',
      classification: 'differential-only',
      callers: ['libs/run-preparation/src/legacy.ts'],
      deleteAfterM312Pass: true
    });
    expect(inventory('legacy-temporal-differential')).toMatchObject({
      path: 'apps/temporal-worker/src/legacy-temporal-differential.spec.ts',
      classification: 'differential-only',
      callers: ['package.json:test:temporal-worker:legacy'],
      deleteAfterM312Pass: true
    });
    expect(inventory('temporal-spike')).toMatchObject({
      path: 'libs/temporal-spike',
      classification: 'frozen-prototype',
      callers: ['libs/runtime-v2-spike-harness/tests/temporal-real-authority.spec.ts'],
      deleteAfterM312Pass: true
    });
    expect(inventory('restate-spike')).toMatchObject({
      path: 'libs/restate-spike',
      classification: 'frozen-prototype',
      callers: ['libs/runtime-v2-spike-harness/tests/restate-real-authority.spec.ts'],
      deleteAfterM312Pass: true
    });
    expect(inventory('runtime-v2-spike-harness')).toMatchObject({
      path: 'libs/runtime-v2-spike-harness',
      classification: 'test-only',
      callers: ['apps/temporal-worker/src/legacy-temporal-differential.spec.ts'],
      deleteAfterM312Pass: true
    });
    expect(inventory('forge-application-services')).toMatchObject({
      path: 'libs/orchestration-runtime/src/lib',
      classification: 'reusable-application-service',
      callers: [
        'apps/cli/src/app.ts',
        'libs/forge-runtime-composition/src/forge-runtime-composition.ts'
      ],
      deleteAfterM312Pass: false,
      keep: [
        'TaskOutputAdmissionCoordinator',
        'RepairExecutionCoordinator',
        'ForgeRunProgressionService',
        'ForgeReadModel'
      ]
    });
    for (const entry of manifest.inventory) {
      expect(existsSync(resolve(workspaceRoot, entry.path))).toBe(true);
    }
    expect(manifest.blockers).toEqual([]);
    expect(manifest.m312ExternalSmoke).toMatchObject({
      status: 'PASS_AWAITING_INDEPENDENT_REVIEW',
      provider: 'deepseek',
      model: 'deepseek-flash',
      result: 'COMPLETED'
    });
    expect(manifest.finalCutoverAssertions).toEqual([
      'M3.12 real external-effect smoke is recorded as PASS.',
      'M3.13 remains CLOSED/FROZEN.',
      'Production package roots remain isolated from legacy-only module entries.',
      'forge run launches only through TemporalRunLauncher and startForgeRun.',
      'The independently deployed worker is the only production activity composition process.',
      'status and cancel use the configured SQLite authority database.',
      'ForgeReadModel remains provider-neutral.',
      'Every differential-only assertion has a durable replacement or explicit retirement decision.'
    ]);
  });
});
