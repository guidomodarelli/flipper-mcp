import {Sequence} from './buffer/RingBuffer.js';
import {compileRegex, textMatcher} from './buffer/filters.js';
import type {Config} from './config.js';
import {FlipperBridge, PluginCallError, type ClientState} from './flipper/FlipperBridge.js';
import {FlipperConnection} from './flipper/FlipperConnection.js';
import type {Recorder} from './flipper/Recorder.js';
import {FLUX_PLUGIN, FluxStore, renderAction, type FluxAction} from './stores/FluxStore.js';
import {LogStore} from './stores/LogStore.js';
import {NetworkStore, summarize} from './stores/NetworkStore.js';
import {PrefsStore} from './stores/PrefsStore.js';
import {UiStore} from './stores/UiStore.js';

/** Error whose message tells the agent what to do next. */
export class ActionableError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ActionableError';
  }
}

export type WaitCondition =
  | {type: 'network_idle'; idleMs?: number; url?: string}
  | {type: 'network_request'; url: string; method?: string}
  | {type: 'log_match'; regex: string; tag?: string}
  | {type: 'flux_action'; actionType: string}
  | {type: 'view_match'; filter: string};

export interface WaitResult {
  matched: boolean;
  waitedMs: number;
  event?: unknown;
  hint?: string;
}

/** Everything the MCP tools need: connection, app tracking and event stores. */
export class Debugger {
  readonly sequence = new Sequence();
  readonly connection: FlipperConnection;
  readonly bridge: FlipperBridge;
  readonly network: NetworkStore;
  readonly logs: LogStore;
  readonly ui = new UiStore();
  readonly prefs: PrefsStore;
  readonly flux: FluxStore;
  private readonly startedAt = Date.now();

  constructor(
    readonly config: Config,
    recorder?: Recorder,
  ) {
    this.connection = new FlipperConnection(config, recorder);
    this.bridge = new FlipperBridge(this.connection, config);
    this.network = new NetworkStore(config, this.sequence);
    this.logs = new LogStore(config, this.sequence);
    this.prefs = new PrefsStore(config, this.sequence);
    this.flux = new FluxStore(config, this.sequence);

    this.bridge.on('plugin-message', (message) => {
      this.network.handle(message);
      this.ui.handle(message);
      this.prefs.handle(message);
      this.flux.handle(message);
    });
    // A new app session restarts the ui-debugger counters; drop the old screen.
    this.bridge.on('client-connected', (client) => this.ui.forget(client.id));
    this.bridge.on('client-disconnected', (client) => this.network.forgetPartials(client.id));
    this.bridge.on('device-log', ({serial, entry}) => this.logs.add(serial, entry));
    this.bridge.on('device-crash', ({serial, crash}) => this.logs.addCrash(serial, crash));
  }

  start(): void {
    this.bridge.start();
  }

  stop(): void {
    this.bridge.stop();
  }

  status() {
    return {
      server: {
        url: this.connection.url,
        state: this.connection.state,
        lastError: this.connection.lastError,
      },
      uptimeMs: Date.now() - this.startedAt,
      buffers: {
        logs: {size: this.logs.buffer.size, capacity: this.logs.buffer.capacity, evicted: this.logs.buffer.evicted},
        network: {size: this.network.buffer.size, capacity: this.network.buffer.capacity, evicted: this.network.buffer.evicted},
        flux: {size: this.flux.buffer.size, capacity: this.flux.buffer.capacity, evicted: this.flux.buffer.evicted},
      },
    };
  }

  listDevices() {
    return {
      ...this.status(),
      devices: [...this.bridge.devices.values()].map((d) => ({
        serial: d.serial,
        title: d.title,
        os: d.os,
        type: d.deviceType,
        connected: d.connected,
        sdk: d.sdkVersion,
      })),
    };
  }

  listApps() {
    return {
      server: this.status().server,
      apps: [...this.bridge.clients.values()].map((c) => ({
        id: c.id,
        app: c.app,
        appId: c.appId,
        device: c.device,
        serial: c.deviceId,
        connected: c.connected,
        ready: c.ready,
        plugins: c.plugins,
        backgroundPlugins: c.backgroundPlugins.length ? c.backgroundPlugins : undefined,
        lastError: c.lastError,
      })),
    };
  }

  private describeDevices(): string {
    const devices = [...this.bridge.devices.values()].filter((d) => d.connected);
    return devices.length ? JSON.stringify(devices.map((d) => `${d.title} (${d.serial})`)) : '[]';
  }

  private requireServer(): void {
    if (this.connection.state !== 'connected') throw new ActionableError(this.connection.describeDisconnected());
  }

  /**
   * Resolves the target app. `app` may be a client id, an app name or a
   * fragment of the id. Without `app`, the only connected app is used.
   */
  resolveClient(app?: string, {requireConnected = true} = {}): ClientState {
    const all = [...this.bridge.clients.values()];
    const candidates = requireConnected ? all.filter((c) => c.connected) : all;
    if (app) {
      const needle = app.toLowerCase();
      const exact = candidates.filter(
        (c) => c.id === app || c.app.toLowerCase() === needle || c.appId?.toLowerCase() === needle,
      );
      const found = exact.length ? exact : candidates.filter((c) => c.id.toLowerCase().includes(needle));
      if (found.length === 1) return found[0]!;
      if (found.length > 1) {
        throw new ActionableError(`"${app}" matches several apps; pass the full id.`, {apps: found.map((c) => c.id)});
      }
      throw new ActionableError(`No ${requireConnected ? 'connected ' : ''}app matches "${app}".`, {
        apps: all.map((c) => ({id: c.id, connected: c.connected})),
      });
    }
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) {
      this.requireServer();
      throw new ActionableError(
        `No app connected to flipper-server. Devices available: ${this.describeDevices()}. Launch a debug build of the app with Flipper enabled; it appears here automatically.`,
        {disconnectedApps: all.map((c) => c.id)},
      );
    }
    throw new ActionableError('Several apps are connected; pass `app` with one of these ids.', {
      apps: candidates.map((c) => c.id),
    });
  }

  /** Same as resolveClient but returns undefined when no `app` was given and none/many are connected. */
  optionalClient(app?: string): ClientState | undefined {
    if (app) return this.resolveClient(app, {requireConnected: false});
    const connected = [...this.bridge.clients.values()].filter((c) => c.connected);
    return connected.length === 1 ? connected[0] : undefined;
  }

  async callPlugin<T = unknown>(app: string | undefined, plugin: string, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    this.requireServer();
    const client = this.resolveClient(app);
    try {
      return await this.bridge.callPlugin<T>(client.id, plugin, method, params, timeoutMs);
    } catch (error) {
      if (error instanceof PluginCallError) {
        throw new ActionableError(`${plugin}.${method} failed: ${error.message}`, {
          errorName: error.errorName,
          plugins: client.plugins,
        });
      }
      throw new ActionableError(`${plugin}.${method} failed: ${(error as Error).message}`);
    }
  }

  viewHierarchy(app: string | undefined, query: Parameters<UiStore['hierarchy']>[1]) {
    const client = this.resolveClient(app, {requireConnected: false});
    if (!client.plugins.includes('ui-debugger')) {
      const legacy = client.plugins.includes('Inspector');
      throw new ActionableError(
        legacy
          ? "The app only has the legacy 'Inspector' plugin. Add UIDebuggerFlipperPlugin (com.facebook.flipper.plugins.uidebugger) to the app, or call call_plugin_method(plugin='Inspector', method='getRoot')."
          : `The app does not have the 'ui-debugger' plugin. Plugins: ${JSON.stringify(client.plugins)}.`,
      );
    }
    const result = this.ui.hierarchy(client.id, query);
    if (!result) {
      if (client.connected) this.bridge.send(client.id, 'init', {plugin: 'ui-debugger'});
      throw new ActionableError(
        'No view hierarchy received yet from ui-debugger. The plugin was just initialised; wait ~1 s and retry. Make sure the app is in the foreground.',
      );
    }
    return result;
  }

  private requireFluxPlugin(client: ClientState): void {
    if (client.ready && !client.plugins.includes(FLUX_PLUGIN)) {
      throw new ActionableError(
        `The app does not expose the '${FLUX_PLUGIN}' plugin. Add FluxDispatcherFlipperPlugin from android/flux-flipper to the debug build (see README).`,
        {plugins: client.plugins},
      );
    }
  }

  async fluxCall<T>(app: string | undefined, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = this.resolveClient(app);
    this.requireFluxPlugin(client);
    return this.callPlugin<T>(client.id, FLUX_PLUGIN, method, params);
  }

  /**
   * Dispatches an action on the app and, unless waitMs is 0, waits for the
   * resulting `action` message (same traceId) to report its store diffs and
   * the HTTP requests it started.
   */
  async dispatchAction(app: string | undefined, type: string, payload: unknown, waitMs: number) {
    const client = this.resolveClient(app);
    this.requireFluxPlugin(client);
    const pending = waitMs > 0 ? this.nextFluxAction(client.id, type, waitMs) : undefined;
    const {traceId} = await this.callPlugin<{traceId: string}>(client.id, FLUX_PLUGIN, 'dispatchAction', {type, payload});
    if (!pending) return {traceId};
    const matching = (a: FluxAction) => a.traceId === traceId && a.type === type;
    const action = this.flux.buffer.findLast(matching) ?? (await pending.wait(matching));
    pending.cancel();
    // Requests started by the action reach Flipper a moment after the action itself.
    if (action) await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 300)));
    return {
      traceId,
      action: action ? renderAction(action, true, true) : undefined,
      requests: this.network.query({traceId, clientId: client.id, limit: 20}).items,
      ...(action ? {} : {hint: `No '${type}' action with traceId ${traceId} arrived within ${waitMs} ms.`}),
    };
  }

  private nextFluxAction(clientId: string, type: string, timeoutMs: number) {
    const seen: FluxAction[] = [];
    const onAction = (a: FluxAction) => {
      if (a.clientId === clientId && a.type === type) seen.push(a);
    };
    this.flux.on('action', onAction);
    const cancel = () => this.flux.off('action', onAction);
    const wait = (match: (a: FluxAction) => boolean) =>
      new Promise<FluxAction | undefined>((resolve) => {
        const started = Date.now();
        const poll = setInterval(() => {
          const found = seen.find(match);
          if (found || Date.now() - started >= timeoutMs) {
            clearInterval(poll);
            resolve(found);
          }
        }, 20);
      });
    return {wait, cancel};
  }

  async waitFor(condition: WaitCondition, timeoutMs: number, app?: string): Promise<WaitResult> {
    const client = this.optionalClient(app);
    const clientId = client?.id;
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    // Validate user patterns before arming timers.
    const logRegex = condition.type === 'log_match' ? compileRegex(condition.regex) : undefined;

    return new Promise<WaitResult>((resolve) => {
      const cleanups: (() => void)[] = [];
      const finish = (result: WaitResult) => {
        for (const cleanup of cleanups) cleanup();
        resolve(result);
      };
      const timer = setTimeout(() => finish(this.timeoutResult(condition, elapsed(), client)), timeoutMs);
      cleanups.push(() => clearTimeout(timer));

      switch (condition.type) {
        case 'log_match': {
          const regex = logRegex!;
          const tag = textMatcher(condition.tag);
          const onLog = (entry: import('./stores/LogStore.js').LogEntry) => {
            if (regex.test(entry.message) && (!tag || tag(entry.tag)) && (!client || entry.serial === client.deviceId)) {
              finish({
                matched: true,
                waitedMs: elapsed(),
                event: {id: entry.id, ts: entry.ts, level: entry.level, tag: entry.tag, msg: entry.message},
              });
            }
          };
          this.logs.on('log', onLog);
          cleanups.push(() => this.logs.off('log', onLog));
          break;
        }
        case 'flux_action': {
          const type = textMatcher(condition.actionType)!;
          const onAction = (action: import('./stores/FluxStore.js').FluxAction) => {
            if ((!clientId || action.clientId === clientId) && type(action.type)) {
              finish({matched: true, waitedMs: elapsed(), event: renderAction(action, true, true)});
            }
          };
          this.flux.on('action', onAction);
          cleanups.push(() => this.flux.off('action', onAction));
          break;
        }
        case 'network_request': {
          const url = textMatcher(condition.url)!;
          const method = condition.method?.toUpperCase();
          const onChange = (entry: import('./stores/NetworkStore.js').NetworkEntry) => {
            if (
              entry.status !== undefined &&
              entry.responseTs !== undefined &&
              entry.responseTs >= started &&
              (!clientId || entry.clientId === clientId) &&
              url(entry.url) &&
              (!method || entry.method.toUpperCase() === method)
            ) {
              finish({matched: true, waitedMs: elapsed(), event: summarize(entry)});
            }
          };
          this.network.on('change', onChange);
          cleanups.push(() => this.network.off('change', onChange));
          break;
        }
        case 'view_match': {
          // ui-debugger pushes frames a few hundred ms after a change; poll the latest one.
          const poll = setInterval(() => {
            if (!clientId) return;
            let found: {nodes?: unknown[]} | undefined;
            try {
              found = this.ui.hierarchy(clientId, {filter: condition.filter, maxNodes: 5}) as typeof found;
            } catch {
              found = undefined; // frame without a root yet
            }
            if (found?.nodes?.length) finish({matched: true, waitedMs: elapsed(), event: found.nodes[0]});
          }, 100);
          cleanups.push(() => clearInterval(poll));
          break;
        }
        case 'network_idle': {
          const idleMs = condition.idleMs ?? 1000;
          const url = textMatcher(condition.url);
          let lastActivity = started;
          const onChange = (entry: import('./stores/NetworkStore.js').NetworkEntry) => {
            if ((!clientId || entry.clientId === clientId) && (!url || url(entry.url))) lastActivity = Date.now();
          };
          this.network.on('change', onChange);
          const poll = setInterval(() => {
            const pending = this.network.pending(clientId).filter((e) => !url || url(e.url));
            const idleFor = Date.now() - lastActivity;
            if (pending.length === 0 && idleFor >= idleMs) {
              finish({matched: true, waitedMs: elapsed(), event: {idleForMs: idleFor}});
            }
          }, 50);
          cleanups.push(() => {
            clearInterval(poll);
            this.network.off('change', onChange);
          });
          break;
        }
        default:
          finish({matched: false, waitedMs: 0, hint: `Unknown condition ${(condition as {type: string}).type}`});
      }
    });
  }

  private timeoutResult(condition: WaitCondition, waitedMs: number, client?: ClientState): WaitResult {
    let hint: string | undefined;
    if (condition.type === 'flux_action' && client && !client.plugins.includes(FLUX_PLUGIN)) {
      hint = `The app does not expose the '${FLUX_PLUGIN}' plugin, so flux actions never arrive.`;
    } else if (condition.type === 'network_idle') {
      const pending = this.network.pending(client?.id).map(summarize);
      hint = pending.length ? `Still pending: ${JSON.stringify(pending.slice(0, 5))}` : undefined;
    } else if (this.connection.state !== 'connected') {
      hint = this.connection.describeDisconnected();
    }
    return {matched: false, waitedMs, ...(hint ? {hint} : {})};
  }
}
