import {describe, expect, it} from 'vitest';
import {pointer} from './tools.js';

describe('pointer', () => {
  it('returns the root only for the empty pointer', () => {
    expect(pointer({a: 1}, '')).toEqual({a: 1});
  });

  it('treats "/" as the property with an empty name', () => {
    expect(pointer({'': 42, count: 1}, '/')).toBe(42);
    expect(() => pointer({count: 1}, '/')).toThrow('Nothing at /');
  });

  it('unescapes ~1 and ~0 and walks arrays', () => {
    expect(pointer({'a/b': [{'~k': 7}]}, '/a~1b/0/~0k')).toBe(7);
  });
});
