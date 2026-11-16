import zlib from 'node:zlib';

export interface Header {
  key: string;
  value: string;
}

export function headerValue(headers: Header[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((header) => header.key.toLowerCase() === lower)?.value;
}

/** `[{key,value}]` → `{key: value}`; repeated keys are joined with ", ". */
export function headersToObject(headers: Header[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const {key, value} of headers ?? []) {
    out[key] = key in out ? `${out[key]}, ${value}` : value;
  }
  return out;
}

const TEXTUAL_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|problem\+json|[\w.+-]*\+(json|xml)))/i;

/**
 * Decodes a Network-plugin body: base64, then inflated according to
 * Content-Encoding. Android already sends some bodies inflated, so an
 * inflate failure falls back to the raw bytes (same as the desktop plugin).
 */
export function decodeBody(base64: string | null | undefined, headers: Header[] | undefined): Buffer | undefined {
  if (!base64) return undefined;
  const raw = Buffer.from(base64, 'base64');
  const encoding = headerValue(headers, 'content-encoding')?.toLowerCase().trim();
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(raw);
    if (encoding === 'deflate') return zlib.inflateSync(raw);
    if (encoding === 'br') return zlib.brotliDecompressSync(raw);
  } catch {
    return raw;
  }
  return raw;
}

export interface RenderedBody {
  bytes: number;
  contentType?: string;
  /** Present for textual bodies. */
  text?: string;
  /** Present for binary bodies. */
  base64?: string;
  binary?: boolean;
  truncated?: boolean;
}

function looksTextual(buffer: Buffer, contentType: string | undefined): boolean {
  if (contentType && TEXTUAL_TYPE.test(contentType)) return true;
  if (contentType && /^(image|audio|video|font)\/|octet-stream|protobuf/i.test(contentType)) return false;
  const sample = buffer.subarray(0, 512);
  if (sample.includes(0)) return false;
  return !sample.toString('utf8').includes('\uFFFD');
}

/** Renders a body for an agent, truncated to `maxBytes` unless `maxBytes` is Infinity. */
export function renderBody(buffer: Buffer | undefined, headers: Header[] | undefined, maxBytes: number): RenderedBody | undefined {
  if (!buffer) return undefined;
  const contentType = headerValue(headers, 'content-type');
  const truncated = buffer.length > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  if (looksTextual(buffer, contentType)) {
    return {bytes: buffer.length, contentType, text: slice.toString('utf8'), ...(truncated ? {truncated} : {})};
  }
  return {bytes: buffer.length, contentType, binary: true, base64: slice.toString('base64'), ...(truncated ? {truncated} : {})};
}
