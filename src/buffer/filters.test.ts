import {describe, expect, it} from 'vitest';
import {compact, parseTime, statusMatcher, textMatcher} from './filters.js';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

describe('parseTime', () => {
  it.each([
    ['30s', NOW - 30_000],
    ['-5m', NOW - 300_000],
    ['1h', NOW - 3_600_000],
    ['250ms', NOW - 250],
    ['2026-11-16T11:00:00Z', NOW - 3_600_000],
    ['1700000000000', 1_700_000_000_000],
  ])('parses %s', (input, expected) => {
    expect(parseTime(input, NOW)).toBe(expected);
  });

  it('passes numbers through and ignores empty input', () => {
    expect(parseTime(42, NOW)).toBe(42);
    expect(parseTime(undefined, NOW)).toBeUndefined();
    expect(parseTime('', NOW)).toBeUndefined();
  });

  it('explains the accepted formats on bad input', () => {
    expect(() => parseTime('yesterday', NOW)).toThrow('relative duration');
  });
});

describe('textMatcher', () => {
  it('matches substrings case-insensitively', () => {
    const match = textMatcher('API/Users')!;

    expect(match('https://x.dev/api/users/1')).toBe(true);
    expect(match('https://x.dev/api/orders')).toBe(false);
    expect(match(undefined)).toBe(false);
  });

  it('treats /.../ as a regex', () => {
    const match = textMatcher('/users\\/\\d+$/')!;

    expect(match('/users/42')).toBe(true);
    expect(match('/users/me')).toBe(false);
  });

  it('reports invalid regexes', () => {
    expect(() => textMatcher('/(/')).toThrow('Invalid regex');
  });

  it('returns undefined without a pattern', () => {
    expect(textMatcher(undefined)).toBeUndefined();
  });
});

describe('statusMatcher', () => {
  it('matches an exact code', () => {
    const match = statusMatcher(404)!;

    expect(match(404, false)).toBe(true);
    expect(match(200, false)).toBe(false);
  });

  it('matches a class like 5xx', () => {
    const match = statusMatcher('5xx')!;

    expect([500, 503, 499].map((s) => match(s, false))).toEqual([true, true, false]);
  });

  it('treats error as >=400 or failed, never pending', () => {
    const match = statusMatcher('error')!;

    expect(match(500, false)).toBe(true);
    expect(match(0, false)).toBe(true);
    expect(match(undefined, true)).toBe(false);
    expect(match(204, false)).toBe(false);
  });

  it('selects pending requests', () => {
    expect(statusMatcher('pending')!(undefined, true)).toBe(true);
  });

  it('rejects unknown filters', () => {
    expect(() => statusMatcher('bad')).toThrow('Invalid status filter');
  });
});

describe('compact', () => {
  it('drops undefined, null and empty arrays but keeps falsy values', () => {
    expect(compact({a: undefined, b: null, c: [], d: 0, e: false, f: ''})).toEqual({d: 0, e: false, f: ''});
  });
});
