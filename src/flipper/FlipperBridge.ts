import {EventEmitter} from 'node:events';
import type {ClientDescription, ClientResponseType, DeviceDescription, DeviceLogEntry} from 'flipper-common';
import type {Config} from '../config.js';
import type {FlipperConnection, SubscribedEvent} from './FlipperConnection.js';

/**
 * Ids for app requests start here. flipper-server keeps pending replies in a
 * map keyed by id per app connection, shared with the web UI, whose counter
 * starts at 0. The SDK parses ids as int64. See PROTOCOL.md §2.
 */
export const REQUEST_ID_BASE = 2 ** 40;

export interface PluginMessage {
  clientId: string;
  api: string;
  method: string;
  params: unknown;
  ts: number;
}

export interface ClientState {
  id: string;
  app: string;
  appId?: string;
  os: string;
  device: string;
  deviceId: string;
  sdkVersion?: number;
  connected: boolean;
  connectedAt: number;
  disconnectedAt?: number;
  plugins: string[];
  backgroundPlugins: string[];
  /** Last SDK error or handshake problem. */
  lastError?: string;
  ready: boolean;
}

export class PluginCallError extends Error {
  constructor(
    message: string,
    readonly errorName?: string,
    readonly stacktrace?: string,
  ) {
    super(message);
    this.name = 'PluginCallError';
  }
}

export interface BridgeEvents {
  'plugin-message': [PluginMessage];
  'device-log': [{serial: string; entry: DeviceLogEntry}];
  'device-crash': [{serial: string; crash: {reason?: string; callstack?: string; name?: string; date?: unknown}}];
  'client-ready': [ClientState];
  'client-disconnected': [ClientState];
  lifecycle: [{kind: string; detail: Record<string, unknown>}];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tracks devices and apps of a flipper-server and speaks the app protocol
 * (getPlugins / init / execute) on top of FlipperConnection.
 */
export class FlipperBridge extends EventEmitter<BridgeEvents> {
  readonly devices = new Map<string, DeviceDescription & {connected: boolean}>();
  readonly clients = new Map<string, ClientState>();
  private nextRequestId = REQUEST_ID_BASE;
  private reinitTimer?: NodeJS.Timeout;
  private readonly handshakes = new Map<string, Promise<void>>();

  constructor(
    readonly connection: FlipperConnection,
    private readonly config: Config,
  ) {
    super();
    connection.on('event', (name, payload) => this.onServerEvent(name, payload));
    connection.on('connected', () => {
      this.sync().catch((error) => this.lifecycle('sync-error', {message: (error as Error).message}));
    });
    connection.on('state', (state) => {
      if (state === 'disconnected') {
        for (const device of this.devices.values()) device.connected = false;
        for (const client of this.clients.values()) {
          if (client.connected) this.markDisconnected(client);
        }
      }
    });
  }

  start(): void {
    this.connection.start();
    this.reinitTimer = setInterval(() => this.reinitAll(), this.config.reinitIntervalMs);
    this.reinitTimer.unref();
  }

  stop(): void {
    clearInterval(this.reinitTimer);
    this.connection.stop();
  }

  /** Refreshes devices and apps after (re)connecting. */
  async sync(): Promise<void> {
    const [devices, clients] = await Promise.all([
      this.connection.exec<DeviceDescription[]>('device-list'),
      this.connection.exec<ClientDescription[]>('client-list'),
    ]);
    this.devices.clear();
    for (const device of devices) this.devices.set(device.serial, {...device, connected: true});
    const live = new Set(clients.map((client) => client.id));
    for (const client of this.clients.values()) {
      if (client.connected && !live.has(client.id)) this.markDisconnected(client);
    }
    await Promise.all(clients.map((client) => this.onClientConnected(client)));
  }

  private onServerEvent(name: SubscribedEvent, payload: unknown): void {
    switch (name) {
      case 'device-connected': {
        const device = payload as DeviceDescription;
        this.devices.set(device.serial, {...device, connected: true});
        this.lifecycle('device-connected', {serial: device.serial, title: device.title});
        break;
      }
      case 'device-disconnected':
      case 'device-removed': {
        const device = payload as DeviceDescription;
        const known = this.devices.get(device.serial);
        if (name === 'device-removed') this.devices.delete(device.serial);
        else if (known) known.connected = false;
        this.lifecycle(name, {serial: device.serial});
        break;
      }
      case 'device-log':
        this.emit('device-log', payload as {serial: string; entry: DeviceLogEntry});
        break;
      case 'device-crash':
        this.emit('device-crash', payload as BridgeEvents['device-crash'][0]);
        break;
      case 'client-connected':
        void this.onClientConnected(payload as ClientDescription);
        break;
      case 'client-disconnected': {
        const client = this.clients.get((payload as {id: string}).id);
        if (client) this.markDisconnected(client);
        break;
      }
      case 'client-setup-error': {
        const {client, message} = payload as {client: {appName?: string; deviceName?: string}; message: string};
        this.lifecycle('client-setup-error', {app: client?.appName, device: client?.deviceName, message});
        break;
      }
      case 'client-message': {
        const {id, message} = payload as {id: string; message: string};
        this.onClientMessage(id, message);
        break;
      }
      default:
        break;
    }
  }

  private lifecycle(kind: string, detail: Record<string, unknown>): void {
    this.emit('lifecycle', {kind, detail});
  }

  private markDisconnected(client: ClientState): void {
    client.connected = false;
    client.ready = false;
    client.disconnectedAt = Date.now();
    this.lifecycle('client-disconnected', {id: client.id});
    this.emit('client-disconnected', client);
  }

  private onClientConnected(description: ClientDescription): Promise<void> {
    const {query} = description;
    const previous = this.clients.get(description.id);
    const state: ClientState = {
      id: description.id,
      app: query.app,
      appId: query.app_id,
      os: query.os,
      device: query.device,
      deviceId: query.device_id,
      sdkVersion: query.sdk_version,
      connected: true,
      connectedAt: previous?.connected ? previous.connectedAt : Date.now(),
      plugins: previous?.plugins ?? [],
      backgroundPlugins: previous?.backgroundPlugins ?? [],
      ready: false,
    };
    this.clients.set(description.id, state);
    if (!previous?.connected) this.lifecycle('client-connected', {id: description.id});
    return this.handshake(state);
  }

  /** getPlugins → getBackgroundPlugins → init(autoInitPlugins). Deduplicated per client. */
  private handshake(client: ClientState): Promise<void> {
    const running = this.handshakes.get(client.id);
    if (running) return running;
    const task = (async () => {
      try {
        let plugins: string[] | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < 5 && plugins === undefined; attempt++) {
          try {
            plugins = (await this.request<{plugins: string[]}>(client.id, 'getPlugins', undefined, 5000)).plugins;
          } catch (error) {
            lastError = error;
            if (!client.connected) return;
            await sleep(1000);
          }
        }
        if (!plugins) throw lastError;
        client.plugins = plugins;
        if ((client.sdkVersion ?? 4) >= 4) {
          try {
            client.backgroundPlugins = (
              await this.request<{plugins: string[]}>(client.id, 'getBackgroundPlugins', undefined, 10000)
            ).plugins;
          } catch {
            client.backgroundPlugins = [];
          }
        }
        this.initAutoPlugins(client);
        client.ready = true;
        client.lastError = undefined;
        this.emit('client-ready', client);
      } catch (error) {
        client.lastError = `handshake failed: ${(error as Error).message ?? String(error)}`;
      } finally {
        this.handshakes.delete(client.id);
      }
    })();
    this.handshakes.set(client.id, task);
    return task;
  }

  private initAutoPlugins(client: ClientState): void {
    for (const plugin of this.config.autoInitPlugins) {
      if (client.plugins.includes(plugin)) this.send(client.id, 'init', {plugin});
    }
  }

  /** `init` is idempotent on the SDK; this undoes a `deinit` sent by the web UI. */
  private reinitAll(): void {
    if (this.connection.state !== 'connected') return;
    for (const client of this.clients.values()) {
      if (client.connected && client.ready) this.initAutoPlugins(client);
    }
  }

  private onClientMessage(clientId: string, raw: string): void {
    let message: {method?: string; params?: {api?: string; method?: string; params?: unknown}; error?: {message?: string}};
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    const client = this.clients.get(clientId);
    if (message.method === 'execute' && message.params?.api && message.params.method) {
      this.emit('plugin-message', {
        clientId,
        api: message.params.api,
        method: message.params.method,
        params: message.params.params,
        ts: Date.now(),
      });
    } else if (message.method === 'refreshPlugins' && client) {
      client.ready = false;
      void this.handshake(client);
    } else if (message.error && client) {
      client.lastError = message.error.message ?? JSON.stringify(message.error);
      this.lifecycle('sdk-error', {id: clientId, message: client.lastError});
    }
  }

  /** Fire-and-forget message to the app (`client-request`). */
  send(clientId: string, method: string, params?: unknown): void {
    if (this.connection.state !== 'connected') return;
    this.connection.exec('client-request', [clientId, {method, params}]).catch(() => undefined);
  }

  /** Request with reply (`client-request-response`). */
  async request<T>(clientId: string, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const id = this.nextRequestId++;
    const response = await this.connection.exec<ClientResponseType>(
      'client-request-response',
      [clientId, {id, method, params}],
      timeoutMs,
    );
    if (response && 'error' in response && response.error) {
      throw new PluginCallError(response.error.message, response.error.name, response.error.stacktrace);
    }
    if (!response || !('success' in response)) {
      throw new PluginCallError(`Empty response from app for '${method}' (is the app still connected?)`);
    }
    return response.success as T;
  }

  /**
   * Calls a plugin method on the app. Sends `init` first (a no-op when the
   * plugin is already connected) and retries once on ConnectionNotFound,
   * which happens when another client (the web UI) sent `deinit`.
   */
  async callPlugin<T = unknown>(clientId: string, api: string, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const client = this.clients.get(clientId);
    if (!client?.connected) throw new PluginCallError(`App ${clientId} is not connected.`);
    if (client.ready && !client.plugins.includes(api)) {
      throw new PluginCallError(
        `The app does not have the '${api}' plugin. Plugins available: ${JSON.stringify(client.plugins)}.`,
        'PluginNotFound',
      );
    }
    const params_ = {api, method, params: params ?? {}};
    this.send(clientId, 'init', {plugin: api});
    try {
      return await this.request<T>(clientId, 'execute', params_, timeoutMs);
    } catch (error) {
      if (error instanceof PluginCallError && error.errorName === 'ConnectionNotFound') {
        this.send(clientId, 'init', {plugin: api});
        await sleep(200);
        return this.request<T>(clientId, 'execute', params_, timeoutMs);
      }
      throw error;
    }
  }
}
