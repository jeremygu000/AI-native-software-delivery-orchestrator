import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/planning',
  resolve: {
    alias: {
      '@ai-native-software-delivery-orchestrator/conflict-engine': resolve(
        import.meta.dirname,
        '../conflict-engine/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/dag': resolve(
        import.meta.dirname,
        '../dag/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/domain': resolve(
        import.meta.dirname,
        '../domain/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/scheduler': resolve(
        import.meta.dirname,
        '../scheduler/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/task-impact': resolve(
        import.meta.dirname,
        '../task-impact/src/index.ts'
      )
    }
  },
  test: {
    name: 'planning',
    watch: false,
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
});
