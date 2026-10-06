import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      '{apps,libs}/*/vite.config.{mjs,js,ts,mts}',
      '{apps,libs}/*/vitest.config.{mjs,js,ts,mts}'
    ],
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.ts', 'libs/*/src/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/src/index.ts', 'apps/cli/src/main.ts'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90
      }
    }
  }
});
