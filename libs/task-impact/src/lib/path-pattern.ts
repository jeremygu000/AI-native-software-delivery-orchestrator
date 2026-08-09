const escapeRegularExpression = (value: string): string =>
  value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');

export const normalizeRepositoryPath = (value: string): string =>
  value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');

export const matchesPathPattern = (path: string, pattern: string): boolean => {
  const normalizedPath = normalizeRepositoryPath(path);
  const normalizedPattern = normalizeRepositoryPath(pattern);
  let expression = '';

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === '*') {
      const nextCharacter = normalizedPattern[index + 1];
      if (nextCharacter === '*') {
        const followingCharacter = normalizedPattern[index + 2];
        expression += followingCharacter === '/' ? '(?:.*/)?' : '.*';
        index += followingCharacter === '/' ? 2 : 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegularExpression(character);
    }
  }

  return new RegExp(`^${expression}$`, 'u').test(normalizedPath);
};
