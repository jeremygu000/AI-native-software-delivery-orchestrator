import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  extends: '../../vitest.config.ts',
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**']
  }
});
