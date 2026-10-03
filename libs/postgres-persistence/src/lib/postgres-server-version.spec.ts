import { describe, expect, it } from 'vitest';
import { resolvePostgresAuthorityServerMajor } from './postgres-server-version.js';

describe('PostgreSQL authority server compatibility', () => {
  it.each([140000, 140015, 150014, 160010, 170006, 180006])(
    'accepts validated major and patch version %i',
    (version) => {
      expect(resolvePostgresAuthorityServerMajor(version)).toBe(Math.floor(version / 10_000));
    }
  );

  it.each([130023, 190000, 190001, 200000, 0, -1, 180000.5, Number.NaN, Infinity])(
    'rejects unsupported or malformed version %s',
    (version) => {
      expect(() => resolvePostgresAuthorityServerMajor(version)).toThrow('validated server major');
    }
  );
});
