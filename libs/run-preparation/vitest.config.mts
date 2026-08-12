import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/run-preparation',
  resolve: {
    alias: {
      '@ai-native-software-delivery-orchestrator/agent-runtime': resolve(
        import.meta.dirname,
        '../agent-runtime/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/domain': resolve(
        import.meta.dirname,
        '../domain/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/orchestration-runtime': resolve(
        import.meta.dirname,
        '../orchestration-runtime/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/planning': resolve(
        import.meta.dirname,
        '../planning/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/persistence': resolve(
        import.meta.dirname,
        '../persistence/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/runtime-guard': resolve(
        import.meta.dirname,
        '../runtime-guard/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/scheduler': resolve(
        import.meta.dirname,
        '../scheduler/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/workspace-git': resolve(
        import.meta.dirname,
        '../workspace-git/src/index.ts'
      )
    }
  },
  test: {
    name: 'run-preparation',
    watch: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts'],
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 }
    }
  }
});
