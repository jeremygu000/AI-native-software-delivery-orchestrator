import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/temporal-worker',
  resolve: {
    conditions: ['@ai-native-software-delivery-orchestrator/source']
  },
  ssr: {
    resolve: {
      conditions: ['@ai-native-software-delivery-orchestrator/source']
    }
  },
  test: {
    name: 'temporal-worker',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Temporal workers and the compiled-process acceptance both use local server resources.
    fileParallelism: false,
    reporters: ['default']
  }
}));
