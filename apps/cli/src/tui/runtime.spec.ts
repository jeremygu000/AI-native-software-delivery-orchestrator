import { describe, expect, it } from 'vitest';
import { supportsCodingTui } from './runtime.js';

describe('interactive-only native runtime boundary', () => {
  it('requires the official Node version and explicitly enabled FFI', () => {
    expect(supportsCodingTui('26.4.0', ['--experimental-ffi'])).toBe(true);
    expect(supportsCodingTui('27.0.0', [], '--enable-source-maps --experimental-ffi')).toBe(true);
    expect(supportsCodingTui('26.3.0', ['--experimental-ffi'])).toBe(false);
    expect(supportsCodingTui('24.0.0', ['--experimental-ffi'])).toBe(false);
    expect(supportsCodingTui('26.4.0', [])).toBe(false);
    expect(supportsCodingTui('26.4.0', [], '--experimental-ffi=false')).toBe(false);
  });
});
