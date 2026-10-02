import { runIsolatedPiSession } from './isolated-pi-session.mjs';

try {
  await runIsolatedPiSession(undefined);
} catch {
  process.stderr.write('Isolated Pi session failed\n');
  process.exitCode = 1;
}
