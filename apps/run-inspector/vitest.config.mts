import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@ai-native-software-delivery-orchestrator/source'] },
  ssr: { resolve: { conditions: ['@ai-native-software-delivery-orchestrator/source'] } },
  test: { name: 'run-inspector', environment: 'node', include: ['src/**/*.spec.ts'] }
});
