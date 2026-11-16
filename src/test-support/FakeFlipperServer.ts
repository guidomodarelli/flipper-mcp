import {WebSocketServer, type WebSocket} from 'ws';
import type {AddressInfo} from 'node:net';

/**
 * Fake flipper-server for tests. It speaks the same envelopes as
 * flipper-server 0.273.0 (PROTOCOL.md §1): validates `?token=`, answers
 * `exec` and pushes `server-event`s. The "app" side is scripted through
 * `onAppRequest`, which receives the payload of client-request(-response).
 */
export interface FakeApp {
  id: string;
  query: {app: string; app_id?: string; os: string; device: string; device_id: string; sdk_version: number; medium: number};
  plugins: string[];
  backgroundPlugins: string[];
  /** Reply for `execute` calls: api.method → result or error. */
  handlers: Record<string, (params: any) => unknown>;
  /** Plugins currently `init`-ed on the fake SDK. */
  connected: Set<string>;
  /** Listed by client-list (set by connectApp). */
  online: boolean;
  received: {method: string; params?: any; id?: number}[];
}

export class FakeFlipperServer {
  private wss?: WebSocketServer;
  readonly sockets = new Set<WebSocket>();
  readonly execLog: {command: string; args: unknown[]}[] = [];
  readonly devices: unknown[] = [];
  readonly apps = new Map<string, FakeApp>();
  port = 0;
  rejectedConnections = 0;

  constructor(readonly token = 'test-token') {}

  async start(port = 0): Promise<number> {
    this.wss = new WebSocketServer({
      port,
      host: '127.0.0.1',
      verifyClient: ({req}: {req: import('node:http').IncomingMessage}) => {
        const ok = new URL(req.url ?? '/', 'http://x').searchParams.get('token') === this.token;
        if (!ok) this.rejectedConnections += 1;
        return ok;
      },
    });
    await new Promise<void>((resolve) => this.wss!.once('listening', () => resolve()));
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (data) => this.onMessage(socket, data.toString()));
    });
    return this.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    this.wss = undefined;
  }

  /** Drops every WS client (simulates a server crash / restart). */
  dropClients(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  emitEvent(event: string, data: unknown): void {
    const frame = JSON.stringify({event: 'server-event', payload: {event, data}});
    for (const socket of this.sockets) socket.send(frame);
  }

  addApp(app: Omit<FakeApp, 'connected' | 'received' | 'online'>): FakeApp {
    const full: FakeApp = {...app, connected: new Set(), received: [], online: false};
    this.apps.set(app.id, full);
    return full;
  }

  connectApp(id: string): void {
    const app = this.apps.get(id)!;
    app.online = true;
    this.emitEvent('client-connected', {id: app.id, query: app.query});
  }

  disconnectApp(id: string): void {
    const app = this.apps.get(id)!;
    app.online = false;
    app.connected.clear();
    this.emitEvent('client-disconnected', {id});
  }

  /** App → desktop push, as the SDK would send it. */
  pushFromApp(id: string, api: string, method: string, params: unknown): void {
    this.emitEvent('client-message', {id, message: JSON.stringify({method: 'execute', params: {api, method, params}})});
  }

  private onMessage(socket: WebSocket, raw: string): void {
    const {event, payload} = JSON.parse(raw) as {event: string; payload: {id: number; command: string; args: unknown[]}};
    if (event !== 'exec') return;
    this.execLog.push({command: payload.command, args: payload.args});
    Promise.resolve()
      .then(() => this.exec(payload.command, payload.args))
      .then(
        (data) => socket.send(JSON.stringify({event: 'exec-response', payload: {id: payload.id, data}})),
        (error: Error) =>
          socket.send(JSON.stringify({event: 'exec-response-error', payload: {id: payload.id, data: `Error: ${error.message}`}})),
      );
  }

  private exec(command: string, args: unknown[]): unknown {
    switch (command) {
      case 'device-list':
        return this.devices;
      case 'client-list':
        return [...this.apps.values()].filter((app) => app.online).map((app) => ({id: app.id, query: app.query}));
      case 'client-request':
        this.appRequest(args[0] as string, args[1] as {method: string; params?: any});
        return undefined;
      case 'client-request-response':
        return this.appRequest(args[0] as string, args[1] as {method: string; params?: any; id: number});
      case 'device-shell-exec':
        return '4242\n';
      default:
        throw new Error(`fake server: unsupported command ${command}`);
    }
  }

  /** Mirrors xplat/Flipper/FlipperClient.cpp onMessageReceived. */
  private appRequest(id: string, message: {method: string; params?: any; id?: number}) {
    const app = this.apps.get(id);
    if (!app) return {length: 0, error: {message: 'Client not found', name: 'Error', stacktrace: ''}};
    app.received.push(message);
    const ok = (success: unknown) => ({success, length: JSON.stringify(success ?? null).length});
    const fail = (name: string, text: string) => ({error: {message: text, name, stacktrace: ''}, length: 0});
    switch (message.method) {
      case 'getPlugins':
        return ok({plugins: app.plugins});
      case 'getBackgroundPlugins':
        return ok({plugins: app.backgroundPlugins});
      case 'init':
        app.connected.add(message.params.plugin);
        return undefined;
      case 'deinit':
        app.connected.delete(message.params.plugin);
        return undefined;
      case 'execute': {
        const {api, method, params} = message.params;
        if (!app.connected.has(api)) return fail('ConnectionNotFound', `Connection ${api} not found for method execute`);
        const handler = app.handlers[`${api}.${method}`];
        if (!handler) return fail('Error', `Receiver ${method} not found.`);
        try {
          return ok(handler(params));
        } catch (error) {
          return fail('Error', (error as Error).message);
        }
      }
      default:
        return fail('Error', `Received unknown method: ${message.method}`);
    }
  }
}
