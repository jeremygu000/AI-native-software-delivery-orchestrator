import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/cli',
  resolve: {
    alias: {
      '@ai-native-software-delivery-orchestrator/agent-runtime': resolve(
        import.meta.dirname,
        '../../libs/agent-runtime/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/conflict-engine': resolve(
        import.meta.dirname,
        '../../libs/conflict-engine/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/dag': resolve(
        import.meta.dirname,
        '../../libs/dag/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/domain': resolve(
        import.meta.dirname,
        '../../libs/domain/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/repository-analysis': resolve(
        import.meta.dirname,
        '../../libs/repository-analysis/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/planning': resolve(
        import.meta.dirname,
        '../../libs/planning/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/scheduler': resolve(
        import.meta.dirname,
        '../../libs/scheduler/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/task-impact': resolve(
        import.meta.dirname,
        '../../libs/task-impact/src/index.ts'
      )
    }
  },
  test: {
    name: 'cli',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
      include: ['src/app.ts'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
  }
}));
