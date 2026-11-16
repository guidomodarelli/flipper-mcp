import {EventEmitter} from 'node:events';
import type {DeviceLogEntry} from 'flipper-common';
import {RingBuffer, type Sequence, type Stamped} from '../buffer/RingBuffer.js';
import {compact, parseTime, textMatcher, truncate} from '../buffer/filters.js';
import type {Config} from '../config.js';

export const LEVELS = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LEVELS)[number] | 'unknown';

export interface LogEntry extends Stamped {
  serial: string;
  level: LogLevel;
  tag: string;
  message: string;
  pid: number;
  tid: number;
  app?: string;
  traceId?: string;
}

export interface LogFilter {
  /** Minimum level: "warn" returns warn, error and fatal. */
  level?: string;
  /** Substring or /regex/ on the tag. */
  tag?: string;
  /** Substring or /regex/ on the message. */
  grep?: string;
  pid?: number;
  serial?: string;
  since?: string | number;
  until?: string | number;
  afterId?: number;
  limit?: number;
  traceId?: string;
}

const TRACE_IN_MESSAGE = /\btrace[-_]?id[=:\s]+([\w-]{4,})/i;

function levelRank(level: string): number {
  const index = LEVELS.indexOf(level as (typeof LEVELS)[number]);
  return index === -1 ? -1 : index;
}

/** `device-log` events (logcat) → ring buffer. Crashes are stored as fatal entries. */
export class LogStore extends EventEmitter<{log: [LogEntry]}> {
  readonly buffer: RingBuffer<LogEntry>;

  constructor(
    private readonly config: Config,
    sequence: Sequence,
  ) {
    super();
    this.buffer = new RingBuffer<LogEntry>(config.buffers.logs, sequence);
  }

  add(serial: string, entry: DeviceLogEntry): LogEntry {
    const date = new Date(entry.date as unknown as string).getTime();
    const stored = this.buffer.push({
      ts: Number.isNaN(date) ? Date.now() : date,
      serial,
      level: entry.type,
      tag: entry.tag ?? '',
      message: entry.message ?? '',
      pid: entry.pid,
      tid: entry.tid,
      app: entry.app,
      traceId: TRACE_IN_MESSAGE.exec(entry.message ?? '')?.[1],
    });
    this.emit('log', stored);
    return stored;
  }

  addCrash(serial: string, crash: {name?: string; reason?: string; callstack?: string}): LogEntry {
    return this.add(serial, {
      date: new Date(),
      type: 'fatal',
      tag: 'flipper-crash',
      message: [crash.name, crash.reason, crash.callstack].filter(Boolean).join('\n'),
      pid: 0,
      tid: 0,
    });
  }

  query(filter: LogFilter) {
    if (filter.level && levelRank(filter.level) === -1) {
      throw new Error(`Invalid level "${filter.level}". Use one of ${LEVELS.join(', ')}.`);
    }
    const minRank = filter.level ? levelRank(filter.level) : -1;
    const tag = textMatcher(filter.tag);
    const grep = textMatcher(filter.grep);
    const page = this.buffer.query({
      since: parseTime(filter.since),
      until: parseTime(filter.until),
      afterId: filter.afterId,
      limit: filter.limit ?? 100,
      predicate: (entry) =>
        levelRank(entry.level) >= minRank &&
        (!tag || tag(entry.tag)) &&
        (!grep || grep(entry.message)) &&
        (filter.pid === undefined || entry.pid === filter.pid) &&
        (!filter.serial || entry.serial === filter.serial) &&
        (!filter.traceId || entry.traceId === filter.traceId),
    });
    return {
      ...page,
      items: page.items.map((entry) =>
        compact({
          id: entry.id,
          ts: entry.ts,
          level: entry.level,
          tag: entry.tag,
          pid: entry.pid,
          msg: truncate(entry.message, this.config.logMessageMaxChars).text,
          traceId: entry.traceId,
        }),
      ),
    };
  }
}
