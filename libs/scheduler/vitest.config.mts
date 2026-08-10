import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/scheduler',
  resolve: {
    alias: {
      '@ai-native-software-delivery-orchestrator/dag': resolve(
        import.meta.dirname,
        '../dag/src/index.ts'
      ),
      '@ai-native-software-delivery-orchestrator/domain': resolve(
        import.meta.dirname,
        '../domain/src/index.ts'
      )
    }
  },
  test: {
    name: 'scheduler',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
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
