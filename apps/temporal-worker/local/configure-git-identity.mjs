import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = resolve('.env.local');
let text = await readFile(path, 'utf8');
for (const [key, value] of Object.entries({
  FORGE_GIT_AUTHOR_NAME: 'Forge Local Experiment',
  FORGE_GIT_AUTHOR_EMAIL: 'forge-local@localhost'
})) {
  const expression = new RegExp(`^${key}=.*$`, 'm');
  text = expression.test(text)
    ? text.replace(expression, `${key}=${value}`)
    : `${text.trimEnd()}\n${key}=${value}\n`;
}
await writeFile(path, text);
await chmod(path, 0o600);
console.log('Local confined Git commit identity configured; repository config unchanged');
