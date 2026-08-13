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
      '**/vite.config.{mjs,js,ts,mts}',
      '**/vitest.config.{mjs,js,ts,mts}',
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
        'libs/agent-runtime/src/lib/macos-command-sandbox.ts',
        'libs/domain/src/lib/repository-graph.ts'
      ],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90
      }
    }
  }
});
