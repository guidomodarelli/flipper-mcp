/** Fields every buffered event carries. */
export interface Stamped {
  /** Monotonic id, unique across all buffers of the process. */
  id: number;
  /** Epoch milliseconds. */
  ts: number;
}

/** Process-wide id source so ids never collide across event types. */
export class Sequence {
  private value = 0;
  next(): number {
    this.value += 1;
    return this.value;
  }
}

export interface BufferQuery<T> {
  /** Inclusive lower bound on `ts` (epoch ms). */
  since?: number;
  /** Inclusive upper bound on `ts` (epoch ms). */
  until?: number;
  /** Only events with `id` greater than this (incremental polling). */
  afterId?: number;
  /** Max events returned; the newest ones are kept. */
  limit?: number;
  predicate?: (item: T) => boolean;
}

export interface BufferPage<T> {
  items: T[];
  /** Events that matched before applying `limit`. */
  matched: number;
  /** True when `limit` cut older matches. */
  truncated: boolean;
  /** Pass as `afterId` on the next call to get only newer events. */
  lastId?: number;
}

/**
 * Fixed-capacity FIFO of push events. When full, the oldest event is
 * evicted. Lookups by id are O(1).
 */
export class RingBuffer<T extends Stamped> {
  private readonly slots: (T | undefined)[];
  private start = 0;
  private count = 0;
  private readonly byId = new Map<number, T>();
  private evictedCount = 0;

  constructor(
    readonly capacity: number,
    private readonly sequence: Sequence = new Sequence(),
    /** Called with each event dropped because the buffer was full. */
    private readonly onEvict?: (item: T) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.slots = new Array(capacity);
  }

  /** Next value of the shared id sequence (for revision cursors). */
  nextSequence(): number {
    return this.sequence.next();
  }

  get size(): number {
    return this.count;
  }

  /** Events dropped because the buffer was full. */
  get evicted(): number {
    return this.evictedCount;
  }

  /** Stores an event, assigning its id. `ts` defaults to now. */
  push(item: Omit<T, 'id' | 'ts'> & {ts?: number}): T {
    const stored = {...item, id: this.sequence.next(), ts: item.ts ?? Date.now()} as T;
    if (this.count === this.capacity) {
      const oldest = this.slots[this.start];
      if (oldest) {
        this.byId.delete(oldest.id);
        this.onEvict?.(oldest);
      }
      this.slots[this.start] = stored;
      this.start = (this.start + 1) % this.capacity;
      this.evictedCount += 1;
    } else {
      this.slots[(this.start + this.count) % this.capacity] = stored;
      this.count += 1;
    }
    this.byId.set(stored.id, stored);
    return stored;
  }

  get(id: number): T | undefined {
    return this.byId.get(id);
  }

  /** Oldest to newest. */
  *values(): IterableIterator<T> {
    for (let i = 0; i < this.count; i++) {
      const item = this.slots[(this.start + i) % this.capacity];
      if (item) yield item;
    }
  }

  /** Newest first; stops at the first match. */
  findLast(predicate: (item: T) => boolean): T | undefined {
    for (let i = this.count - 1; i >= 0; i--) {
      const item = this.slots[(this.start + i) % this.capacity];
      if (item && predicate(item)) return item;
    }
    return undefined;
  }

  query(q: BufferQuery<T> = {}): BufferPage<T> {
    const matches: T[] = [];
    for (const item of this.values()) {
      if (q.afterId !== undefined && item.id <= q.afterId) continue;
      if (q.since !== undefined && item.ts < q.since) continue;
      if (q.until !== undefined && item.ts > q.until) continue;
      if (q.predicate && !q.predicate(item)) continue;
      matches.push(item);
    }
    const limit = q.limit ?? matches.length;
    const items = limit >= matches.length ? matches : matches.slice(matches.length - limit);
    return {
      items,
      matched: matches.length,
      truncated: items.length < matches.length,
      lastId: items.at(-1)?.id,
    };
  }

  clear(): void {
    this.slots.fill(undefined);
    this.byId.clear();
    this.start = 0;
    this.count = 0;
  }
}
