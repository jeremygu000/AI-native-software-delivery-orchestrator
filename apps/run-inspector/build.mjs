import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

const root = import.meta.dirname;
await mkdir(`${root}/dist/web`, { recursive: true });
await build({
  entryPoints: [`${root}/src/main.ts`],
  outfile: `${root}/dist/main.js`,
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true
});
await build({
  entryPoints: [`${root}/web/app.tsx`],
  outfile: `${root}/dist/web/app.js`,
  bundle: true,
  platform: 'browser',
  conditions: ['@ai-native-software-delivery-orchestrator/source'],
  target: 'es2022',
  format: 'esm',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }
});
await copyFile(`${root}/web/index.html`, `${root}/dist/web/index.html`);
