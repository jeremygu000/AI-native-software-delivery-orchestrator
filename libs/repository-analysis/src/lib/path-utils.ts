import { access } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const toPortablePath = (path: string): string => path.split(sep).join('/');

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const isWithin = (parent: string, candidate: string): boolean => {
  const relativePath = relative(parent, candidate);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
};
