import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/runtime-guard',
  resolve: {
    alias: {
      '@ai-native-software-delivery-orchestrator/domain': resolve(
        import.meta.dirname,
        '../domain/src/index.ts'
      )
    }
  },
  test: {
    name: 'runtime-guard',
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
