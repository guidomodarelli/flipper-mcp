import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {loadConfig, type Config} from './config.js';
import {Debugger} from './Debugger.js';
import {REQUEST_ID_BASE} from './flipper/FlipperBridge.js';
import {createMcpServer} from './mcp/server.js';
import {FakeFlipperServer, type FakeApp} from './test-support/FakeFlipperServer.js';
import * as fx from './test-support/fixtures.js';

interface Harness {
  fake: FakeFlipperServer;
  dbg: Debugger;
  client: Client;
  app: FakeApp;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  callRaw: (name: string, args?: Record<string, unknown>) => Promise<{isError?: boolean; body: any}>;
}

function testConfig(port: number, overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}, []),
    port,
    host: '127.0.0.1',
    token: 'test-token',
    reinitIntervalMs: 100,
    execTimeoutMs: 2000,
    ...overrides,
  };
}

async function setup(overrides: Partial<Config> = {}): Promise<Harness> {
  const fake = new FakeFlipperServer();
  const port = await fake.start();
  fake.devices.push(fx.device);
  const app = fake.addApp({
    id: fx.APP_ID,
    query: fx.demoQuery,
    plugins: ['Network', 'Databases', 'Preferences', 'ui-debugger', 'FluxDispatcher'],
    backgroundPlugins: ['Network'],
    handlers: {
      'Databases.databaseList': () => [{id: 1, name: '/data/data/com.example.demo/databases/app.db', tables: ['users']}],
      'Databases.execute': ({value}: {value: string}) =>
        value.startsWith('SELECT')
          ? {
              type: 'select',
              columns: ['id', 'name'],
              values: [
                [{type: 'integer', value: 1}, {type: 'string', value: 'ana'}],
                [{type: 'integer', value: 2}, {type: 'null', value: null}],
              ],
            }
          : {type: 'update_delete', affectedCount: 3},
      'Preferences.getAllSharedPreferences': () => ({
        session_prefs: {token: 'abc', onboarded: true},
        flags: {dark_mode: false},
      }),
      'FluxDispatcher.getStores': () => ({stores: ['SessionStore']}),
    },
  });
  const dbg = new Debugger(testConfig(port, overrides));
  dbg.start();
  const server = createMcpServer(dbg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({name: 'test', version: '0'});
  await client.connect(clientTransport);
  const callRaw = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({name, arguments: args})) as {isError?: boolean; content: {text: string}[]};
    return {isError: result.isError, body: JSON.parse(result.content[0]!.text)};
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const {isError, body} = await callRaw(name, args);
    if (isError) throw new Error(`${name} failed: ${JSON.stringify(body)}`);
    return body;
  };
  await vi.waitFor(() => expect(dbg.connection.state).toBe('connected'), {timeout: 3000});
  return {fake, dbg, client, app, call, callRaw};
}

async function connectApp(h: Harness) {
  h.fake.connectApp(fx.APP_ID);
  await vi.waitFor(() => expect(h.dbg.bridge.clients.get(fx.APP_ID)?.ready).toBe(true), {timeout: 3000});
}

let h: Harness;

beforeEach(async () => {
  h = await setup();
});

afterEach(async () => {
  await h.client.close();
  h.dbg.stop();
  await h.fake.stop();
});

describe('connection and handshake', () => {
  it('lists devices and an app after the SDK handshake', async () => {
    await connectApp(h);

    const devices = await h.call('list_devices');
    const apps = await h.call('list_apps');

    expect(devices.devices).toEqual([expect.objectContaining({serial: 'emulator-5554', title: 'Pixel_7', connected: true})]);
    expect(apps.apps).toEqual([
      expect.objectContaining({id: fx.APP_ID, appId: 'com.example.demo', connected: true, ready: true, backgroundPlugins: ['Network']}),
    ]);
  });

  it('runs getPlugins → getBackgroundPlugins → init with request ids outside the web UI range', async () => {
    await connectApp(h);

    const methods = h.app.received.map((m) => (m.method === 'init' ? `init:${m.params.plugin}` : m.method));
    const ids = h.app.received.filter((m) => m.id !== undefined).map((m) => m.id!);

    expect(methods.slice(0, 2)).toEqual(['getPlugins', 'getBackgroundPlugins']);
    expect(methods).toEqual(expect.arrayContaining(['init:Network', 'init:Preferences', 'init:ui-debugger', 'init:FluxDispatcher']));
    expect(methods).not.toContain('init:Databases');
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(REQUEST_ID_BASE);
  });

  it('stays ready when client-connected arrives twice during the handshake', async () => {
    h.fake.connectApp(fx.APP_ID);
    h.fake.connectApp(fx.APP_ID);

    await vi.waitFor(() => expect(h.dbg.bridge.clients.get(fx.APP_ID)?.ready).toBe(true), {timeout: 3000});
    const apps = await h.call('list_apps');
    expect(apps.apps[0]).toMatchObject({ready: true, plugins: expect.arrayContaining(['ui-debugger'])});
  });

  it('re-sends init after the web UI deinits a plugin', async () => {
    await connectApp(h);
    h.app.connected.delete('ui-debugger');

    await vi.waitFor(() => expect(h.app.connected.has('ui-debugger')).toBe(true), {timeout: 1000});
  });

  it('reconnects after the server drops the socket and resyncs apps', async () => {
    await connectApp(h);
    const syncsBefore = h.fake.execLog.filter((e) => e.command === 'client-list').length;

    h.fake.dropClients();

    await vi.waitFor(
      () => expect(h.fake.execLog.filter((e) => e.command === 'client-list').length).toBeGreaterThan(syncsBefore),
      {timeout: 5000},
    );
    await vi.waitFor(() => expect(h.dbg.bridge.clients.get(fx.APP_ID)?.ready).toBe(true), {timeout: 3000});
  });

  it('explains how to fix a missing app, listing the devices', async () => {
    const {isError, body} = await h.callRaw('list_databases');

    expect(isError).toBe(true);
    expect(body.error).toContain('No app connected to flipper-server');
    expect(body.error).toContain('Pixel_7 (emulator-5554)');
  });

  it('marks the app disconnected but keeps its buffered data', async () => {
    await connectApp(h);
    h.fake.pushFromApp(fx.APP_ID, 'Network', 'newRequest', fx.newRequest('r1', 'https://api.dev/a'));
    await vi.waitFor(() => expect(h.dbg.network.buffer.size).toBe(1));

    h.fake.disconnectApp(fx.APP_ID);

    await vi.waitFor(() => expect(h.dbg.bridge.clients.get(fx.APP_ID)?.connected).toBe(false));
    expect((await h.call('get_network_requests')).items).toHaveLength(1);
  });
});

describe('auth', () => {
  it('reports a rejected token with the env vars to check', async () => {
    const other = new FakeFlipperServer('right');
    const port = await other.start();
    const dbg = new Debugger(testConfig(port, {token: 'wrong'}));
    dbg.start();

    await vi.waitFor(() => expect(dbg.connection.lastError).toContain('401'), {timeout: 3000});
    expect(dbg.connection.describeDisconnected()).toContain('FLIPPER_TOKEN');

    dbg.stop();
    await other.stop();
  });
});

describe('network', () => {
  beforeEach(() => connectApp(h));

  it('pairs requests with gzip responses and ignores replayed messages', async () => {
    const body = JSON.stringify({users: Array.from({length: 200}, (_, i) => ({id: i}))});
    for (let replay = 0; replay < 2; replay++) {
      h.fake.pushFromApp(fx.APP_ID, 'Network', 'newRequest', fx.newRequest('r1', 'https://api.dev/users'));
      h.fake.pushFromApp(fx.APP_ID, 'Network', 'newResponse', fx.newResponse('r1', 200, body, {gzip: true}));
    }
    h.fake.pushFromApp(fx.APP_ID, 'Network', 'newRequest', fx.newRequest('r2', 'https://api.dev/login', {method: 'POST'}));
    h.fake.pushFromApp(fx.APP_ID, 'Network', 'newResponse', fx.newResponse('r2', 500, '{"error":"boom"}'));
    await vi.waitFor(() => expect(h.dbg.network.buffer.query({predicate: (e) => e.status !== undefined}).matched).toBe(2));

    const all = await h.call('get_network_requests');
    const errors = await h.call('get_network_requests', {status: 'error'});

    expect(all.items.map((e: any) => [e.requestId, e.status, e.durationMs])).toEqual([
      ['r1', 200, 120],
      ['r2', 500, 120],
    ]);
    expect(errors.items).toEqual([expect.objectContaining({method: 'POST', url: 'https://api.dev/login', status: 500})]);
  });

  it('truncates bodies by default and returns them whole with full=true', async () => {
    const body = JSON.stringify({items: 'x'.repeat(5000)});
    h.fake.pushFromApp(fx.APP_ID, 'Network', 'newRequest', fx.newRequest('big', 'https://api.dev/big'));
    h.fake.pushFromApp(fx.APP_ID, 'Network', 'newResponse', fx.newResponse('big', 200, body, {gzip: true}));
    await vi.waitFor(() => expect(h.dbg.network.find('big')?.status).toBe(200));

    const preview = await h.call('get_network_request', {id: 'big'});
    const full = await h.call('get_network_request', {id: 'big', full: true});

    expect(preview.responseBody).toMatchObject({bytes: body.length, truncated: true});
    expect(preview.responseBody.text).toHaveLength(2048);
    expect(preview.hint).toContain('full=true');
    expect(full.responseBody.text).toBe(body);
    expect(full.responseHeaders).toMatchObject({'Content-Encoding': 'gzip'});
  });

  it('reassembles partialResponse chunks that arrive out of order', async () => {
    const body = JSON.stringify({chunked: 'y'.repeat(300)});
    const chunks = fx.partialResponses('p1', 200, body, 3);
    h.fake.pushFromApp(fx.APP_ID, 'Network', 'newRequest', fx.newRequest('p1', 'https://api.dev/chunked'));
    for (const chunk of [chunks[2], chunks[0], chunks[1]]) h.fake.pushFromApp(fx.APP_ID, 'Network', 'partialResponse', chunk);
    await vi.waitFor(() => expect(h.dbg.network.find('p1')?.status).toBe(200));

    const detail = await h.call('get_network_request', {id: 'p1', full: true});

    expect(detail.responseBody.text).toBe(body);
  });

  it('extracts the trace id header to correlate with flux actions', async () => {
    h.fake.pushFromApp(
      fx.APP_ID,
      'Network',
      'newRequest',
      fx.newRequest('t1', 'https://api.dev/me', {headers: [{key: 'X-Flux-Trace-Id', value: 'trace-42'}]}),
    );
    await vi.waitFor(() => expect(h.dbg.network.buffer.size).toBe(1));

    const page = await h.call('get_network_requests', {traceId: 'trace-42'});

    expect(page.items).toEqual([expect.objectContaining({requestId: 't1', traceId: 'trace-42', pending: true})]);
  });

  it('says how to recover when the id is unknown', async () => {
    const {isError, body} = await h.callRaw('get_network_request', {id: 'nope'});

    expect(isError).toBe(true);
    expect(body.error).toContain('evicted');
  });
});

describe('logs', () => {
  beforeEach(() => connectApp(h));

  it('filters by minimum level, tag and grep and supports incremental polling', async () => {
    h.fake.emitEvent('device-log', fx.logEntry('debug', 'OkHttp', '--> GET /users'));
    h.fake.emitEvent('device-log', fx.logEntry('warn', 'Session', 'token expiring soon'));
    h.fake.emitEvent('device-log', fx.logEntry('error', 'Session', 'refresh failed traceId=abc123'));
    await vi.waitFor(() => expect(h.dbg.logs.buffer.size).toBe(3));

    const warnings = await h.call('get_logs', {level: 'warn', tag: 'session'});
    const grep = await h.call('get_logs', {grep: '/refresh\\s+failed/'});
    const after = await h.call('get_logs', {afterId: warnings.lastId});

    expect(warnings.items.map((e: any) => e.level)).toEqual(['warn', 'error']);
    expect(grep.items).toEqual([expect.objectContaining({tag: 'Session', traceId: 'abc123'})]);
    expect(after.items).toEqual([]);
  });

  it('restricts to the app process with onlyApp', async () => {
    h.fake.emitEvent('device-log', fx.logEntry('info', 'Demo', 'mine', 4242));
    h.fake.emitEvent('device-log', fx.logEntry('info', 'system', 'other', 99));
    await vi.waitFor(() => expect(h.dbg.logs.buffer.size).toBe(2));

    const mine = await h.call('get_logs', {onlyApp: true});

    expect(mine.items.map((e: any) => e.msg)).toEqual(['mine']);
  });
});

describe('view hierarchy', () => {
  beforeEach(() => connectApp(h));

  it('returns a pruned tree with text, resource ids and absolute bounds, without hidden views', async () => {
    h.fake.pushFromApp(fx.APP_ID, 'ui-debugger', 'metadataUpdate', fx.uiMetadata);
    h.fake.pushFromApp(fx.APP_ID, 'ui-debugger', 'subtreeUpdate', fx.subtreeUpdate);
    await vi.waitFor(() => expect(h.dbg.ui.hasFrame(fx.APP_ID)).toBe(true));

    const tree = await h.call('get_view_hierarchy');

    expect(tree.root).toEqual({
      id: 1,
      cls: 'DecorView',
      b: [0, 0, 1080, 2400],
      children: [
        {
          id: 2,
          cls: 'LinearLayout',
          resId: 'content',
          b: [0, 100, 1080, 2300],
          children: [
            {id: 3, cls: 'TextView', text: 'Hola Flux', resId: 'title', b: [40, 120, 600, 80]},
            {id: 4, cls: 'Button', text: 'Ingresar', resId: 'login_button', b: [40, 300, 300, 120]},
          ],
        },
      ],
    });
  });

  it('cuts at maxDepth and reports how many children were left out', async () => {
    h.fake.pushFromApp(fx.APP_ID, 'ui-debugger', 'subtreeUpdate', fx.subtreeUpdate);
    await vi.waitFor(() => expect(h.dbg.ui.hasFrame(fx.APP_ID)).toBe(true));

    const tree = await h.call('get_view_hierarchy', {maxDepth: 1});

    expect(tree.root.children).toEqual([expect.objectContaining({id: 2, more: 4})]);
  });

  it('returns matching nodes with their path when filtering', async () => {
    h.fake.pushFromApp(fx.APP_ID, 'ui-debugger', 'metadataUpdate', fx.uiMetadata);
    h.fake.pushFromApp(fx.APP_ID, 'ui-debugger', 'subtreeUpdate', fx.subtreeUpdate);
    await vi.waitFor(() => expect(h.dbg.ui.hasFrame(fx.APP_ID)).toBe(true));

    const result = await h.call('get_view_hierarchy', {filter: 'ingresar'});

    expect(result.nodes).toEqual([
      {id: 4, cls: 'Button', text: 'Ingresar', resId: 'login_button', b: [40, 300, 300, 120], path: 'DecorView > LinearLayout'},
    ]);
  });

  it('shows the new screen after the app restarts with a lower txId', async () => {
    h.fake.pushFromApp(fx.APP_ID, 'ui-debugger', 'subtreeUpdate', fx.subtreeUpdate);
    await vi.waitFor(() => expect(h.dbg.ui.hasFrame(fx.APP_ID)).toBe(true));
    h.fake.disconnectApp(fx.APP_ID);
    await vi.waitFor(() => expect(h.dbg.bridge.clients.get(fx.APP_ID)?.connected).toBe(false));
    await connectApp(h);

    const restarted = {...fx.subtreeUpdate, txId: 1, nodes: [{...fx.subtreeUpdate.nodes[0]!, name: 'SplashView', children: []}]};
    h.fake.pushFromApp(fx.APP_ID, 'ui-debugger', 'subtreeUpdate', restarted);
    await vi.waitFor(() => expect(h.dbg.ui.hasFrame(fx.APP_ID)).toBe(true));

    expect((await h.call('get_view_hierarchy')).root).toMatchObject({cls: 'SplashView'});
  });

  it('asks to retry when no frame has arrived yet', async () => {
    const {isError, body} = await h.callRaw('get_view_hierarchy');

    expect(isError).toBe(true);
    expect(body.error).toContain('retry');
  });
});

describe('databases and preferences', () => {
  beforeEach(() => connectApp(h));

  it('lists databases and runs a select with flattened values', async () => {
    const databases = await h.call('list_databases');
    const result = await h.call('query_database', {db: 'app.db', sql: 'SELECT id, name FROM users', maxRows: 1});

    expect(databases).toEqual([expect.objectContaining({id: 1, tables: ['users']})]);
    expect(result).toEqual({
      db: '/data/data/com.example.demo/databases/app.db',
      type: 'select',
      columns: ['id', 'name'],
      rows: [[1, 'ana']],
      rowCount: 2,
      truncated: true,
    });
  });

  it('recovers when another client deinits the plugin between calls', async () => {
    await h.call('list_databases');
    h.app.connected.delete('Databases');

    const result = await h.call('query_database', {db: 1, sql: 'DELETE FROM users'});

    expect(result).toMatchObject({type: 'update_delete', affectedCount: 3});
  });

  it('lists the databases when the name does not match', async () => {
    const {isError, body} = await h.callRaw('query_database', {db: 'missing', sql: 'SELECT 1'});

    expect(isError).toBe(true);
    expect(body.databases).toEqual([{id: 1, name: '/data/data/com.example.demo/databases/app.db'}]);
  });

  it('returns one preferences file and, with changesSince, only the changes', async () => {
    h.fake.pushFromApp(fx.APP_ID, 'Preferences', 'sharedPreferencesChange', {
      preferences: 'session_prefs',
      name: 'token',
      time: 1,
      deleted: false,
      value: 'def',
    });
    await vi.waitFor(() => expect(h.dbg.prefs.buffer.size).toBe(1));

    const file = await h.call('get_shared_preferences', {file: 'session'});
    const changes = await h.call('get_shared_preferences', {changesSince: '1m'});

    expect(file).toEqual({session_prefs: {token: 'abc', onboarded: true}});
    expect(changes.items).toEqual([expect.objectContaining({file: 'session_prefs', key: 'token', value: 'def'})]);
  });

  it('forwards any plugin method through call_plugin_method', async () => {
    const reply = await h.call('call_plugin_method', {plugin: 'FluxDispatcher', method: 'getStores'});

    expect(reply).toEqual({stores: ['SessionStore']});
  });

  it('names the available plugins when the plugin does not exist', async () => {
    const {isError, body} = await h.callRaw('call_plugin_method', {plugin: 'Nope', method: 'x'});

    expect(isError).toBe(true);
    expect(body.error).toContain("does not have the 'Nope' plugin");
  });
});

describe('wait_for', () => {
  beforeEach(() => connectApp(h));

  it('returns the first new log line that matches', async () => {
    const waiting = h.call('wait_for', {condition: {type: 'log_match', regex: 'login (ok|done)'}, timeoutMs: 2000});
    setTimeout(() => {
      h.fake.emitEvent('device-log', fx.logEntry('info', 'Auth', 'nothing yet'));
      h.fake.emitEvent('device-log', fx.logEntry('info', 'Auth', 'login done'));
    }, 50);

    const result = await waiting;

    expect(result).toMatchObject({matched: true, event: {tag: 'Auth', msg: 'login done'}});
  });

  it('ignores matching logs from other devices', async () => {
    const waiting = h.call('wait_for', {condition: {type: 'log_match', regex: 'login done'}, timeoutMs: 2000});
    setTimeout(() => {
      h.fake.emitEvent('device-log', {...fx.logEntry('info', 'Auth', 'login done elsewhere'), serial: 'other-device'});
      h.fake.emitEvent('device-log', fx.logEntry('info', 'Auth', 'login done here'));
    }, 50);

    const result = await waiting;

    expect(result.event.msg).toBe('login done here');
  });

  it('waits for network idle until pending requests finish', async () => {
    h.fake.pushFromApp(fx.APP_ID, 'Network', 'newRequest', fx.newRequest('slow', 'https://api.dev/slow'));
    await vi.waitFor(() => expect(h.dbg.network.buffer.size).toBe(1));
    const waiting = h.call('wait_for', {condition: {type: 'network_idle', idleMs: 100}, timeoutMs: 3000});
    setTimeout(() => h.fake.pushFromApp(fx.APP_ID, 'Network', 'newResponse', fx.newResponse('slow', 200, '{}')), 200);

    const result = await waiting;

    expect(result.matched).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(250);
  });

  it('reports what is still pending on timeout', async () => {
    h.fake.pushFromApp(fx.APP_ID, 'Network', 'newRequest', fx.newRequest('stuck', 'https://api.dev/stuck'));
    await vi.waitFor(() => expect(h.dbg.network.buffer.size).toBe(1));

    const result = await h.call('wait_for', {condition: {type: 'network_idle'}, timeoutMs: 300});

    expect(result.matched).toBe(false);
    expect(result.hint).toContain('https://api.dev/stuck');
  });

  it('matches a flux action by type', async () => {
    const waiting = h.call('wait_for', {condition: {type: 'flux_action', actionType: 'LOGIN_'}, timeoutMs: 2000});
    setTimeout(() => h.fake.pushFromApp(fx.APP_ID, 'FluxDispatcher', 'action', fx.fluxAction('LOGIN_REQUESTED', 'trace-1')), 50);

    const result = await waiting;

    expect(result).toMatchObject({matched: true, event: {type: 'LOGIN_REQUESTED', traceId: 'trace-1', stores: ['SessionStore']}});
  });

  it('waits until a matching view shows up in a new frame', async () => {
    h.fake.pushFromApp(fx.APP_ID, 'ui-debugger', 'metadataUpdate', fx.uiMetadata);
    const waiting = h.call('wait_for', {condition: {type: 'view_match', filter: 'Ingresar'}, timeoutMs: 2000});
    setTimeout(() => h.fake.pushFromApp(fx.APP_ID, 'ui-debugger', 'subtreeUpdate', fx.subtreeUpdate), 150);

    const result = await waiting;

    expect(result).toMatchObject({matched: true, event: {resId: 'login_button', text: 'Ingresar'}});
  });

  it('waits for a specific request to complete', async () => {
    const waiting = h.call('wait_for', {condition: {type: 'network_request', url: '/login'}, timeoutMs: 2000});
    setTimeout(() => {
      h.fake.pushFromApp(fx.APP_ID, 'Network', 'newRequest', fx.newRequest('l1', 'https://api.dev/login'));
      h.fake.pushFromApp(fx.APP_ID, 'Network', 'newResponse', fx.newResponse('l1', 401, '{}'));
    }, 50);

    const result = await waiting;

    expect(result).toMatchObject({matched: true, event: {requestId: 'l1', status: 401}});
  });
});
