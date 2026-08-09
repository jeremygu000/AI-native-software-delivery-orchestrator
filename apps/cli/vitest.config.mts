import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/cli',
  resolve: {
    alias: {
      '@ai-native-software-delivery-orchestrator/domain': resolve(
        import.meta.dirname,
        '../../libs/domain/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/repository-analysis': resolve(
        import.meta.dirname,
        '../../libs/repository-analysis/src/index.ts'
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
