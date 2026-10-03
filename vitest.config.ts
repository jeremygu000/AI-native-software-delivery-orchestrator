import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@ai-native-software-delivery-orchestrator/source']
  },
  ssr: {
    resolve: {
      conditions: ['@ai-native-software-delivery-orchestrator/source']
    }
  },
  test: {
    projects: [
      '{apps,libs}/*/vite.config.{mjs,js,ts,mts}',
      '{apps,libs}/*/vitest.config.{mjs,js,ts,mts}',
      '!vitest.config.{mjs,js,ts,mts}',
      '!vite.config.{mjs,js,ts,mts}'
    ],
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.ts', 'libs/*/src/**/*.ts'],
      exclude: [
        '**/*.spec.ts',
        '**/src/index.ts',
        'apps/cli/src/main.ts',
        'apps/cli/src/app.ts',
        // Process entry points are exercised as child processes, outside this V8 collector.
        'apps/temporal-worker/src/main.ts',
        'apps/temporal-worker/src/m3.12-external-smoke.ts',
        // Temporal evaluates bundled workflows in an isolated V8 sandbox.
        'libs/temporal-runtime/src/lib/workflows/forge-run.ts',
        // Unreferenced legacy Scenario A entry adapters are not part of the runtime.
        'libs/temporal-runtime/src/lib/activities/index.ts',
        'libs/orchestration-runtime/src/lib/forge-scenario-a-service-runner.ts',
        'libs/agent-runtime/src/lib/macos-command-sandbox.ts',
        'libs/domain/src/lib/repository-graph.ts',
        'libs/orchestration-runtime/src/lib/forge-builder-execution-service.ts',
        'libs/orchestration-runtime/src/lib/forge-builder-output-evaluation-service.ts',
        'libs/orchestration-runtime/src/lib/forge-repair-execution-service.ts'
      ],
      thresholds: {
        // Keep real provider branches visible; the measured baseline is 85%.
        branches: 85,
        functions: 90,
        lines: 90,
        statements: 90
      }
    }
  }
});
