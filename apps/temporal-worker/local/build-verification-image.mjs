import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repository = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  throw new Error('Usage: build-verification-image.mjs approved-repository');
}
const context = await mkdtemp(join(tmpdir(), 'forge-verification-image-'));
try {
  const tracked = execFileSync('git', ['-C', repository, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(
      (path) =>
        path === 'pnpm-lock.yaml' ||
        path === 'pnpm-workspace.yaml' ||
        /(^|\/)package\.json$/.test(path)
    );
  for (const path of tracked) {
    const destination = join(context, 'manifests', path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(repository, path)));
  }
  await writeFile(
    join(context, 'npm'),
    `#!/bin/sh
set -eu
mkdir -p /tmp/verified-source
cp -R /workspace/. /tmp/verified-source/
find /tmp/verified-source -name node_modules -type d -prune -exec rm -rf '{}' +
cp -R /opt/dependencies/. /tmp/verified-source/
chmod -R u+w /tmp/verified-source
cd /tmp/verified-source
export npm_config_strict_dep_builds=false
export npm_config_manage_package_manager_versions=false
export npm_config_verify_deps_before_run=false
exec node /usr/local/lib/node_modules/npm/bin/npm-cli.js "$@"
`,
    { mode: 0o755 }
  );
  await writeFile(
    join(context, 'pnpm'),
    `#!/bin/sh
set -eu
exec node /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs --config.verify-deps-before-run=false --config.manage-package-manager-versions=false --config.strict-dep-builds=false "$@"
`,
    { mode: 0o755 }
  );
  await writeFile(
    join(context, 'Dockerfile'),
    `FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
RUN npm install --global pnpm@11.1.0 --ignore-scripts
WORKDIR /opt/dependencies
COPY manifests/ ./
RUN pnpm --config.strict-dep-builds=false install --frozen-lockfile --ignore-scripts
RUN rm /usr/local/bin/npm
COPY npm /usr/local/bin/npm
RUN rm /usr/local/bin/pnpm
COPY pnpm /usr/local/bin/pnpm
WORKDIR /workspace
`
  );
  execFileSync('docker', ['build', '--tag', 'forge-groundgraph-verification:local', context], {
    stdio: 'inherit'
  });
  console.log(
    execFileSync(
      'docker',
      ['image', 'inspect', 'forge-groundgraph-verification:local', '--format', '{{.Id}}'],
      { encoding: 'utf8' }
    ).trim()
  );
} finally {
  await rm(context, { recursive: true, force: true });
}
