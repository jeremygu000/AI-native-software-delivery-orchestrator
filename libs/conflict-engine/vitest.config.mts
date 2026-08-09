import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/conflict-engine',
  resolve: {
    alias: {
      '@ai-native-software-delivery-orchestrator/task-impact': resolve(
        import.meta.dirname,
        '../task-impact/src/index.ts'
      )
    },
    conditions: ['@ai-native-software-delivery-orchestrator/source']
  },
  test: {
    name: 'conflict-engine',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90
      }
    }
  }
}));
