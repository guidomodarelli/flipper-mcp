import {EventEmitter} from 'node:events';
import {RingBuffer, type Sequence, type Stamped} from '../buffer/RingBuffer.js';
import {compact, parseTime, textMatcher, truncate} from '../buffer/filters.js';
import type {Config} from '../config.js';
import type {PluginMessage} from '../flipper/FlipperBridge.js';

/** Plugin id of the Android FluxDispatcher plugin (see flux-plugin/ and PROTOCOL.md §4). */
export const FLUX_PLUGIN = 'FluxDispatcher';

export interface StoreChange {
  store: string;
  /** JSON-Patch-like ops: {op: add|remove|replace, path, value?, old?}. */
  diff: unknown[];
}

export interface FluxAction extends Stamped {
  clientId: string;
  type: string;
  payload?: unknown;
  traceId?: string;
  deviceTs?: number;
  durationMs?: number;
  changes?: StoreChange[];
  error?: string;
}

export interface FluxFilter {
  clientId?: string;
  /** Substring or /regex/ on the action type. */
  type?: string;
  /** Only actions that changed this store. */
  store?: string;
  traceId?: string;
  since?: string | number;
  until?: string | number;
  afterId?: number;
  limit?: number;
  includePayload?: boolean;
  includeDiff?: boolean;
}

export class FluxStore extends EventEmitter<{action: [FluxAction]}> {
  readonly buffer: RingBuffer<FluxAction>;

  constructor(config: Config, sequence: Sequence) {
    super();
    this.buffer = new RingBuffer<FluxAction>(config.buffers.flux, sequence);
  }

  handle(message: PluginMessage): void {
    if (message.api !== FLUX_PLUGIN || message.method !== 'action') return;
    const action = message.params as {
      type: string;
      payload?: unknown;
      traceId?: string;
      ts?: number;
      durationMs?: number;
      changes?: StoreChange[];
      error?: string;
    };
    if (!action?.type) return;
    const stored = this.buffer.push({
      ts: message.ts,
      clientId: message.clientId,
      type: action.type,
      payload: action.payload,
      traceId: action.traceId,
      deviceTs: action.ts,
      durationMs: action.durationMs,
      changes: action.changes,
      error: action.error,
    });
    this.emit('action', stored);
  }

  query(filter: FluxFilter) {
    const type = textMatcher(filter.type);
    const page = this.buffer.query({
      since: parseTime(filter.since),
      until: parseTime(filter.until),
      afterId: filter.afterId,
      limit: filter.limit ?? 50,
      predicate: (a) =>
        (!filter.clientId || a.clientId === filter.clientId) &&
        (!type || type(a.type)) &&
        (!filter.traceId || a.traceId === filter.traceId) &&
        (!filter.store || Boolean(a.changes?.some((c) => c.store === filter.store))),
    });
    return {
      ...page,
      items: page.items.map((a) => renderAction(a, filter.includePayload ?? false, filter.includeDiff ?? true)),
    };
  }
}

export function renderAction(action: FluxAction, includePayload: boolean, includeDiff: boolean) {
  const payload =
    includePayload && action.payload !== undefined
      ? truncate(JSON.stringify(action.payload), 2000).text
      : undefined;
  return compact({
    id: action.id,
    ts: action.ts,
    type: action.type,
    traceId: action.traceId,
    durationMs: action.durationMs,
    stores: action.changes?.map((c) => c.store),
    changes: includeDiff ? action.changes : undefined,
    payload,
    error: action.error,
  });
}
