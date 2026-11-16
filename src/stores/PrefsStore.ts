import {EventEmitter} from 'node:events';
import {RingBuffer, type Sequence, type Stamped} from '../buffer/RingBuffer.js';
import {compact, parseTime, textMatcher} from '../buffer/filters.js';
import type {Config} from '../config.js';
import type {PluginMessage} from '../flipper/FlipperBridge.js';

export interface PrefChange extends Stamped {
  clientId: string;
  file: string;
  key: string;
  deleted: boolean;
  value?: unknown;
}

/** `sharedPreferencesChange` pushes from the Preferences plugin. */
export class PrefsStore extends EventEmitter<{change: [PrefChange]}> {
  readonly buffer: RingBuffer<PrefChange>;

  constructor(config: Config, sequence: Sequence) {
    super();
    this.buffer = new RingBuffer<PrefChange>(config.buffers.prefs, sequence);
  }

  handle(message: PluginMessage): void {
    if (message.api !== 'Preferences' || message.method !== 'sharedPreferencesChange') return;
    const change = message.params as {preferences: string; name: string; deleted: boolean; value?: unknown; time?: number};
    const stored = this.buffer.push({
      ts: message.ts,
      clientId: message.clientId,
      file: change.preferences,
      key: change.name,
      deleted: Boolean(change.deleted),
      value: change.value,
    });
    this.emit('change', stored);
  }

  changes(filter: {clientId?: string; file?: string; since?: string | number; afterId?: number; limit?: number}) {
    const file = textMatcher(filter.file);
    const page = this.buffer.query({
      since: parseTime(filter.since),
      afterId: filter.afterId,
      limit: filter.limit ?? 100,
      predicate: (c) => (!filter.clientId || c.clientId === filter.clientId) && (!file || file(c.file)),
    });
    return {
      ...page,
      items: page.items.map((c) => compact({id: c.id, ts: c.ts, file: c.file, key: c.key, deleted: c.deleted || undefined, value: c.value})),
    };
  }
}
