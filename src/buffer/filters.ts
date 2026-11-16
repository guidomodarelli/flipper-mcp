const UNIT_MS: Record<string, number> = {ms: 1, s: 1000, m: 60_000, h: 3_600_000};

/**
 * Parses a time bound given by an agent:
 * - epoch milliseconds (number or numeric string),
 * - a relative duration back from now: "30s", "-5m", "2h", "500ms",
 * - any ISO-8601 date.
 */
export function parseTime(input: string | number | undefined, now = Date.now()): number | undefined {
  if (input === undefined || input === '') return undefined;
  if (typeof input === 'number') return input;
  const trimmed = input.trim();
  if (/^\d{10,}$/.test(trimmed)) return Number(trimmed);
  const relative = /^-?(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(trimmed);
  if (relative) {
    return now - Number(relative[1]) * UNIT_MS[relative[2]!]!;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid time "${input}". Use epoch ms, a relative duration like "30s"/"5m"/"1h", or an ISO date.`,
    );
  }
  return parsed;
}

/**
 * Builds a case-insensitive text matcher. "/regex/flags" is a regex;
 * anything else is a substring.
 */
export function textMatcher(pattern: string | undefined): ((value: string | undefined) => boolean) | undefined {
  if (!pattern) return undefined;
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (regex) {
    let compiled: RegExp;
    try {
      // g/y make RegExp.test stateful (lastIndex), which would skip matches.
      const flags = regex[2]!.replace(/[gy]/g, '');
      compiled = new RegExp(regex[1]!, flags.includes('i') ? flags : `${flags}i`);
    } catch (error) {
      throw new Error(`Invalid regex ${pattern}: ${(error as Error).message}`);
    }
    return (value) => value !== undefined && compiled.test(value);
  }
  const needle = pattern.toLowerCase();
  return (value) => value !== undefined && value.toLowerCase().includes(needle);
}

/** Compiles a user regex (always case-insensitive unless flags say otherwise). */
export function compileRegex(pattern: string, flags = 'i'): RegExp {
  try {
    return new RegExp(pattern, flags.replace(/[gy]/g, ''));
  } catch (error) {
    throw new Error(`Invalid regex "${pattern}": ${(error as Error).message}`);
  }
}

/** Status filter: 404, "4xx", "error" (>=400 or failed), "ok" (2xx/3xx), "pending". */
export function statusMatcher(
  filter: string | number | undefined,
): ((status: number | undefined, pending: boolean) => boolean) | undefined {
  if (filter === undefined || filter === '') return undefined;
  if (typeof filter === 'number' || /^\d{3}$/.test(filter)) {
    const code = Number(filter);
    return (status) => status === code;
  }
  const value = filter.toLowerCase();
  if (/^[1-5]xx$/.test(value)) {
    const hundred = Number(value[0]) * 100;
    return (status) => status !== undefined && status >= hundred && status < hundred + 100;
  }
  if (value === 'error') return (status, pending) => !pending && (status === undefined || status === 0 || status >= 400);
  if (value === 'ok') return (status) => status !== undefined && status >= 200 && status < 400;
  if (value === 'pending') return (_status, pending) => pending;
  throw new Error(`Invalid status filter "${filter}". Use 404, "4xx", "error", "ok" or "pending".`);
}

/** Drops undefined/null/empty-array fields to keep JSON output small. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined || field === null) continue;
    if (Array.isArray(field) && field.length === 0) continue;
    out[key] = field;
  }
  return out as Partial<T>;
}

export function truncate(text: string, max: number): {text: string; truncated: boolean} {
  if (text.length <= max) return {text, truncated: false};
  return {text: `${text.slice(0, max)}…`, truncated: true};
}
