import {EventEmitter} from 'node:events';
import {RingBuffer, type Sequence, type Stamped} from '../buffer/RingBuffer.js';
import {compact, parseTime, statusMatcher, textMatcher} from '../buffer/filters.js';
import type {Config} from '../config.js';
import type {PluginMessage} from '../flipper/FlipperBridge.js';
import {decodeBody, headersToObject, headerValue, renderBody, type Header} from './body.js';

interface RequestInfo {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  headers: Header[];
  data?: string | null;
}

interface ResponseInfo {
  id: string;
  timestamp: number;
  status: number;
  reason?: string;
  headers: Header[];
  data?: string | null;
  isMock?: boolean;
  insights?: unknown;
  totalChunks?: number;
  index?: number;
}

export interface NetworkEntry extends Stamped {
  clientId: string;
  /** Advances on every update (request, then response); `afterId` cursors compare against it. */
  rev: number;
  /** Id assigned by the Network plugin on the device. */
  requestId: string;
  method: string;
  url: string;
  requestHeaders: Header[];
  requestBody?: Buffer;
  requestBytes: number;
  deviceRequestTs: number;
  status?: number;
  reason?: string;
  responseHeaders?: Header[];
  responseBody?: Buffer;
  responseBytes?: number;
  responseTs?: number;
  durationMs?: number;
  isMock?: boolean;
  insights?: unknown;
  traceId?: string;
  /** Body was larger than FLIPPER_MAX_BODY_BYTES and was not kept. */
  bodyDropped?: true;
}

export interface NetworkFilter {
  url?: string;
  method?: string;
  status?: string | number;
  since?: string | number;
  until?: string | number;
  afterId?: number;
  limit?: number;
  traceId?: string;
  clientId?: string;
}

interface PartialResponse {
  initial?: ResponseInfo;
  chunks: Map<number, string>;
}

/**
 * Network plugin messages → ring buffer of request/response pairs.
 * Deduplicates replays (BufferingFlipperPlugin re-sends on every `init`).
 */
export class NetworkStore extends EventEmitter<{change: [NetworkEntry]}> {
  readonly buffer: RingBuffer<NetworkEntry>;
  private readonly index = new Map<string, number>();
  private readonly partials = new Map<string, PartialResponse>();

  constructor(
    private readonly config: Config,
    sequence: Sequence,
  ) {
    super();
    this.buffer = new RingBuffer<NetworkEntry>(config.buffers.network, sequence, (evicted) => {
      const key = this.key(evicted.clientId, evicted.requestId);
      if (this.index.get(key) === evicted.id) this.index.delete(key);
    });
  }

  handle(message: PluginMessage): void {
    if (message.api !== 'Network') return;
    if (message.method === 'newRequest') this.onRequest(message.clientId, message.params as RequestInfo, message.ts);
    else if (message.method === 'newResponse') this.onResponse(message.clientId, message.params as ResponseInfo, message.ts);
    else if (message.method === 'partialResponse') this.onPartial(message.clientId, message.params as ResponseInfo, message.ts);
  }

  private key(clientId: string, requestId: string): string {
    return `${clientId}|${requestId}`;
  }

  private lookup(clientId: string, requestId: string): NetworkEntry | undefined {
    const id = this.index.get(this.key(clientId, requestId));
    const entry = id === undefined ? undefined : this.buffer.get(id);
    if (id !== undefined && !entry) this.index.delete(this.key(clientId, requestId));
    return entry;
  }

  private keepBody(buffer: Buffer | undefined, entry: {bodyDropped?: true}): Buffer | undefined {
    if (buffer && buffer.length > this.config.maxStoredBodyBytes) {
      entry.bodyDropped = true;
      return undefined;
    }
    return buffer;
  }

  private onRequest(clientId: string, request: RequestInfo, ts: number): void {
    if (!request?.id || this.lookup(clientId, request.id)) return; // replay
    const decoded = decodeBody(request.data, request.headers);
    const flags: {bodyDropped?: true} = {};
    const body = this.keepBody(decoded, flags);
    const entry = this.buffer.push({
      ts,
      clientId,
      requestId: request.id,
      method: request.method,
      url: request.url,
      requestHeaders: request.headers ?? [],
      requestBody: body,
      requestBytes: decoded?.length ?? 0,
      deviceRequestTs: request.timestamp,
      traceId: headerValue(request.headers, this.config.traceHeader),
      rev: 0,
      ...flags,
    });
    entry.rev = entry.id;
    this.index.set(this.key(clientId, request.id), entry.id);
    this.emit('change', entry);
  }

  private onResponse(clientId: string, response: ResponseInfo, ts: number, combinedBase64?: string): void {
    if (!response?.id) return;
    let entry = this.lookup(clientId, response.id);
    if (entry?.status !== undefined) return; // replay
    if (!entry) {
      // Request arrived before the MCP started or was evicted.
      entry = this.buffer.push({
        ts,
        clientId,
        requestId: response.id,
        method: '?',
        url: '?',
        requestHeaders: [],
        requestBytes: 0,
        deviceRequestTs: response.timestamp,
        rev: 0,
      });
      this.index.set(this.key(clientId, response.id), entry.id);
    }
    const decoded = decodeBody(combinedBase64 ?? response.data, response.headers);
    entry.status = response.status;
    entry.reason = response.reason;
    entry.responseHeaders = response.headers ?? [];
    entry.responseBody = this.keepBody(decoded, entry);
    entry.responseBytes = decoded?.length ?? 0;
    entry.responseTs = ts;
    entry.durationMs = entry.method === '?' ? undefined : response.timestamp - entry.deviceRequestTs;
    entry.isMock = response.isMock || undefined;
    entry.insights = response.insights ?? undefined;
    entry.rev = this.buffer.nextSequence();
    this.emit('change', entry);
  }

  /** Chunks may arrive in any order; each one is base64 on its own. */
  private onPartial(clientId: string, chunk: ResponseInfo, ts: number): void {
    if (!chunk?.id) return;
    const key = this.key(clientId, chunk.id);
    const partial: PartialResponse = this.partials.get(key) ?? {chunks: new Map()};
    this.partials.set(key, partial);
    const index = chunk.index ?? 0;
    if (index === 0) partial.initial = chunk;
    partial.chunks.set(index, chunk.data ?? '');
    const total = partial.initial?.totalChunks;
    if (!partial.initial || total === undefined || partial.chunks.size < total) return;
    const buffers: Buffer[] = [];
    for (let i = 0; i < total; i++) buffers.push(Buffer.from(partial.chunks.get(i) ?? '', 'base64'));
    this.partials.delete(key);
    this.onResponse(clientId, partial.initial, ts, Buffer.concat(buffers).toString('base64'));
  }

  /** Request ids currently indexed (bounded by the buffer capacity). */
  get indexedRequests(): number {
    return this.index.size;
  }

  /** Requests without a response, started less than `maxAgeMs` ago. */
  pending(clientId?: string, maxAgeMs = 30_000, now = Date.now()): NetworkEntry[] {
    return this.buffer
      .query({since: now - maxAgeMs, predicate: (e) => e.status === undefined && (!clientId || e.clientId === clientId)})
      .items;
  }

  query(filter: NetworkFilter) {
    const url = textMatcher(filter.url);
    const status = statusMatcher(filter.status);
    const method = filter.method?.toUpperCase();
    const page = this.buffer.query({
      since: parseTime(filter.since),
      until: parseTime(filter.until),
      limit: filter.limit ?? 50,
      predicate: (entry) =>
        (filter.afterId === undefined || entry.rev > filter.afterId) &&
        (!filter.clientId || entry.clientId === filter.clientId) &&
        (!url || url(entry.url)) &&
        (!method || entry.method.toUpperCase() === method) &&
        (!status || status(entry.status, entry.status === undefined)) &&
        (!filter.traceId || entry.traceId === filter.traceId),
    });
    // The cursor is the highest revision seen, so a later response shows up again.
    const lastRev = page.items.reduce((max, e) => Math.max(max, e.rev), 0);
    return {...page, lastId: page.items.length ? lastRev : undefined, items: page.items.map(summarize)};
  }

  /** By MCP event id or by the plugin's request id. */
  find(id: number | string, clientId?: string): NetworkEntry | undefined {
    const numeric = typeof id === 'number' ? id : /^\d+$/.test(id) ? Number(id) : undefined;
    if (numeric !== undefined) {
      const entry = this.buffer.get(numeric);
      if (entry && (!clientId || entry.clientId === clientId)) return entry;
    }
    const requestId = String(id);
    return this.buffer.findLast((e) => e.requestId === requestId && (!clientId || e.clientId === clientId));
  }

  detail(entry: NetworkEntry, opts: {full?: boolean; maxBodyBytes?: number; headers?: boolean} = {}) {
    const max = opts.full ? Infinity : (opts.maxBodyBytes ?? this.config.bodyPreviewBytes);
    const withHeaders = opts.headers ?? true;
    return compact({
      ...summarize(entry),
      reason: entry.reason,
      requestHeaders: withHeaders ? headersToObject(entry.requestHeaders) : undefined,
      requestBody: renderBody(entry.requestBody, entry.requestHeaders, max),
      responseHeaders: withHeaders && entry.responseHeaders ? headersToObject(entry.responseHeaders) : undefined,
      responseBody: renderBody(entry.responseBody, entry.responseHeaders, max),
      insights: entry.insights,
      bodyDropped: entry.bodyDropped
        ? `body larger than FLIPPER_MAX_BODY_BYTES (${this.config.maxStoredBodyBytes}) was not stored`
        : undefined,
      hint: !opts.full && (entry.requestBody?.length ?? 0) + (entry.responseBody?.length ?? 0) > max
        ? 'bodies truncated; call again with full=true for the complete body'
        : undefined,
    });
  }
}

export function summarize(entry: NetworkEntry) {
  return compact({
    id: entry.id,
    ts: entry.ts,
    requestId: entry.requestId,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    pending: entry.status === undefined ? true : undefined,
    durationMs: entry.durationMs,
    reqBytes: entry.requestBytes || undefined,
    resBytes: entry.responseBytes || undefined,
    mock: entry.isMock,
    traceId: entry.traceId,
    app: entry.clientId,
  });
}
