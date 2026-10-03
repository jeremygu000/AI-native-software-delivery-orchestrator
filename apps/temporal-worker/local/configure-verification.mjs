import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = resolve(import.meta.dirname, '../../../.env.local');
let text = await readFile(path, 'utf8');
for (const [name, value] of Object.entries({
  FORGE_VERIFICATION_IMAGE:
    'sha256:6a68151302bbd07800a3f76c5387fb3c81e7d0b8a79d2506e8e6e36ef9ec8e2f',
  FORGE_VERIFICATION_TEMPORARY_BYTES: '2147483648',
  FORGE_VERIFICATION_TEMPORARY_EXECUTABLE: 'true'
})) {
  const line = new RegExp(`^${name}=.*$`, 'm');
  text = line.test(text)
    ? text.replace(line, `${name}=${value}`)
    : `${text.trimEnd()}\n${name}=${value}\n`;
}
await writeFile(path, text, { mode: 0o600 });
