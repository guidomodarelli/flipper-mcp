import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {createFlipperServerWithSocket, FlipperServerState} from 'flipper-server-client';
import type {FlipperServer, FlipperServerEvents} from 'flipper-common';
import WebSocket from 'ws';
import type {Config} from '../config.js';
import {ReconnectingWebSocket} from './reconnectingWebSocket.js';
import type {Recorder} from './Recorder.js';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** Server events the MCP subscribes to (see PROTOCOL.md §1). */
export const SUBSCRIBED_EVENTS = [
  'server-state',
  'device-connected',
  'device-disconnected',
  'device-removed',
  'device-log',
  'device-crash',
  'client-setup-error',
  'client-connected',
  'client-disconnected',
  'client-message',
] as const satisfies readonly (keyof FlipperServerEvents)[];

export type SubscribedEvent = (typeof SUBSCRIBED_EVENTS)[number];

/**
 * The client's exec timer is a `setInterval` that is never cleared once it
 * fires (flipper-server-client 0.273.0). We hand it the largest delay Node
 * accepts and enforce our own timeout instead, so a lost reply leaves at most
 * one timer firing every ~24 days.
 */
const CLIENT_LIBRARY_TIMEOUT = 2 ** 31 - 1;
/** flipper-server-client rejects its connect promise after 30 s; we retry after that. */
const REOPEN_DELAY_MS = 1000;

export class ExecError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

export interface ConnectionEvents {
  state: [ConnectionState];
  /** Emitted on the first connection and after every reconnection. */
  connected: [];
  event: [SubscribedEvent, unknown];
}

/**
 * Persistent connection to flipper-server, built on the official
 * flipper-server-client plus reconnecting-websocket. Reconnects forever.
 */
export class FlipperConnection extends EventEmitter<ConnectionEvents> {
  state: ConnectionState = 'disconnected';
  lastError?: string;
  private server?: FlipperServer;
  private socket?: ReconnectingWebSocket;
  private closed = false;
  private reopenTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly recorder?: Recorder,
  ) {
    super();
  }

  /** ws URL without the token, for messages. */
  get url(): string {
    return `ws://${this.config.host}:${this.config.port}`;
  }

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.reopenTimer);
    this.socket?.close();
    this.server = undefined;
    this.setState('disconnected');
  }

  readToken(): string | undefined {
    if (this.config.token) return this.config.token;
    try {
      return fs.readFileSync(this.config.tokenPath, 'utf8').trim();
    } catch {
      this.lastError = `token file not found at ${this.config.tokenPath} (start flipper-server once, or set FLIPPER_TOKEN / FLIPPER_TOKEN_PATH)`;
      return undefined;
    }
  }

  private open(): void {
    const urlProvider = () => {
      const token = this.readToken();
      return token ? `${this.url}/?token=${encodeURIComponent(token)}` : `${this.url}/`;
    };
    const socket = new ReconnectingWebSocket(urlProvider, [], {
      WebSocket,
      minReconnectionDelay: 500,
      maxReconnectionDelay: 5000,
      reconnectionDelayGrowFactor: 1.5,
      connectionTimeout: 4000,
      maxRetries: Infinity,
    });
    this.socket = socket;

    const recorder = this.recorder;
    if (recorder) {
      socket.addEventListener('message', (event) => recorder.write('in', event.data));
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        recorder.write('out', data);
        send(data);
      };
    }
    socket.addEventListener('error', (event) => {
      const message = (event as {message?: string}).message || 'cannot reach flipper-server (connection refused or dropped)';
      this.lastError = /401/.test(message)
        ? `flipper-server rejected the auth token (401). Check FLIPPER_TOKEN_PATH (${this.config.tokenPath}) or FLIPPER_TOKEN.`
        : message;
    });

    createFlipperServerWithSocket(socket as unknown as globalThis.WebSocket, this.config.port, (state) =>
      this.onClientState(state),
    ).then(
      (server) => {
        if (this.closed) return;
        this.server = server;
        for (const name of SUBSCRIBED_EVENTS) {
          server.on(name, (payload: unknown) => this.emit('event', name, payload));
        }
        this.emit('connected');
      },
      (error: Error) => {
        // The client gave up waiting for the first `open`. Start over with a fresh socket.
        this.lastError ??= error.message.split('\n')[0];
        socket.close();
        if (this.closed) return;
        this.reopenTimer = setTimeout(() => this.open(), REOPEN_DELAY_MS);
      },
    );
  }

  private onClientState(state: FlipperServerState): void {
    if (this.closed) return;
    if (state === FlipperServerState.CONNECTED) {
      this.lastError = undefined;
      const wasConnectedBefore = this.server !== undefined;
      this.setState('connected');
      // The first connection is announced once `server` is set; later ones here.
      if (wasConnectedBefore) this.emit('connected');
    } else if (state === FlipperServerState.CONNECTING) {
      this.setState('connecting');
    } else {
      this.setState('disconnected');
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  /** Runs a flipper-server command (PROTOCOL.md §1). */
  async exec<T = unknown>(command: string, args: unknown[] = [], timeoutMs = this.config.execTimeoutMs): Promise<T> {
    const server = this.server;
    if (!server || this.state !== 'connected') {
      throw new ExecError(command, this.describeDisconnected());
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ExecError(command, `flipper-server did not answer '${command}' within ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    try {
      const call = (server.exec as (...a: unknown[]) => Promise<T>)(
        {timeout: CLIENT_LIBRARY_TIMEOUT},
        command,
        ...args,
      );
      return await Promise.race([call, timeout]);
    } catch (error) {
      if (error instanceof ExecError) throw error;
      const message = typeof error === 'string' ? error.split('\n')[0]! : (error as Error).message;
      throw new ExecError(command, message);
    } finally {
      clearTimeout(timer);
    }
  }

  describeDisconnected(): string {
    const reason = this.lastError ? ` Last error: ${this.lastError}.` : '';
    return `Not connected to flipper-server at ${this.url} (state: ${this.state}).${reason} Start it with \`npx flipper-server\` or set FLIPPER_HOST/FLIPPER_PORT. The MCP reconnects automatically.`;
  }
}
