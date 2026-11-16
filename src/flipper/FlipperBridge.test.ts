import {describe, expect, it} from 'vitest';
import {randomRequestIdStart, REQUEST_ID_BASE} from './FlipperBridge.js';

describe('randomRequestIdStart', () => {
  it('stays above the web UI range and within safe integers', () => {
    expect(randomRequestIdStart(() => 0)).toBe(REQUEST_ID_BASE);
    expect(randomRequestIdStart(() => 0.999_999_9)).toBeLessThan(Number.MAX_SAFE_INTEGER - 2 ** 32);
  });

  it('gives different processes different id blocks', () => {
    expect(randomRequestIdStart(() => 0.25)).not.toBe(randomRequestIdStart(() => 0.5));
  });
});
