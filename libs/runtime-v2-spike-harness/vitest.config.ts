import { defineConfig } from 'vitest/config';

export default defineConfig({
  extends: '../../vitest.config.ts',
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**']
  }
});
