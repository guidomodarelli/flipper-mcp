// End-to-end check against a real flipper-server + emulator running android/sample.
// Usage: node scripts/live.mjs [record.jsonl]   (needs adb on ADB or PATH)
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const ADB = process.env.ADB ?? 'adb';
const record = process.argv[2];
const adb = (...args) => execFileSync(ADB, args, {encoding: 'utf8'});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js', ...(record ? ['--record', record] : [])],
  env: {...process.env},
  stderr: 'inherit',
});
const client = new Client({name: 'live', version: '0.0.0'});
await client.connect(transport);

const results = {};
async function call(name, args = {}, {quiet = false} = {}) {
  const result = await client.callTool({name, arguments: args});
  const body = JSON.parse(result.content[0].text);
  const text = JSON.stringify(body);
  if (!quiet) console.log(`\n### ${name} ${JSON.stringify(args)}${result.isError ? ' (ERROR)' : ''}\n${text.length > 1500 ? `${text.slice(0, 1500)}… (${text.length} chars)` : text}`);
  results[name] = body;
  if (result.isError) throw new Error(`${name} failed`);
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Restart the app so it connects while the MCP is a client.
adb('shell', 'am', 'force-stop', 'com.example.fluxsample');
adb('shell', 'am', 'start', '-n', 'com.example.fluxsample/.MainActivity');
let apps;
for (let i = 0; i < 60; i++) {
  apps = (await call('list_apps', {}, {quiet: true})).apps.filter((a) => a.connected && a.ready);
  if (apps.length) break;
  await sleep(1000);
}
await call('list_devices');
await call('list_apps');
if (!apps?.length) throw new Error('app never became ready');

await sleep(2000);
const tree = await call('get_view_hierarchy', {maxDepth: 30, maxNodes: 80});
const login = await call('get_view_hierarchy', {filter: 'login_button'});
const button = login.nodes[0];
const tap = (node) => adb('shell', 'input', 'tap', String(Math.round(node.b[0] + node.b[2] / 2)), String(Math.round(node.b[1] + node.b[3] / 2)));

// Tap Login using the coordinates the MCP returned, and wait for the round trip.
const waiting = call('wait_for', {condition: {type: 'flux_action', actionType: 'LOGIN_SUCCEEDED'}, timeoutMs: 15000});
tap(button);
await waiting;
await call('wait_for', {condition: {type: 'network_idle', idleMs: 500}, timeoutMs: 10000});
const requests = await call('get_network_requests', {url: 'jsonplaceholder'});
await call('get_network_request', {id: requests.items.at(-1).id, maxBodyBytes: 200});
await call('get_logs', {tag: 'FluxSample', limit: 5});
await call('get_logs', {onlyApp: true, level: 'warn', limit: 3});
const actions = await call('get_flux_actions', {includePayload: true});
const hola = {nodes: [(await call('wait_for', {condition: {type: 'view_match', filter: '/^Hola/'}, timeoutMs: 5000})).event]};
const check = (ok, what) => {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`CHECK ok: ${what}`);
};
const loginTrace = requests.items.at(-1).traceId;
check(actions.items.filter((a) => a.traceId === loginTrace).map((a) => a.type).join() === 'LOGIN_REQUESTED,LOGIN_SUCCEEDED', 'request and both login actions share one traceId');
check(hola.nodes[0]?.text?.startsWith('Hola '), 'view text is read from ui-debugger attributes');

// Failing request: 500 + error log + store error state.
const failWait = call('wait_for', {condition: {type: 'network_request', url: 'httpbin.org/status/500'}, timeoutMs: 20000});
const failLog = call('wait_for', {condition: {type: 'log_match', regex: 'login failed: HTTP 500'}, timeoutMs: 20000});
tap((await call('get_view_hierarchy', {filter: 'fail_button'}, {quiet: true})).nodes[0]);
await failWait;
await failLog;
await call('get_network_requests', {status: 'error'});
await call('get_store_state', {store: 'SessionStore'});

// Databases and preferences.
await call('list_databases');
await call('query_database', {db: 'app.db', sql: 'SELECT id, name, role FROM users ORDER BY id'});
check(Boolean((await call('get_shared_preferences', {file: 'session_prefs'})).session_prefs?.user), 'session_prefs has the logged-in user');
await call('get_shared_preferences', {changesSince: '5m'});

// Flux commands: snapshot → dispatch → state → restore.
await call('get_store_state', {});
const snap = await call('snapshot_stores', {});
await call('dispatch_action', {type: 'INCREMENT', payload: {by: 5}});
check((await call('get_store_state', {store: 'CounterStore', path: '/count'})).state === 5, 'dispatch_action INCREMENT by 5');
await call('set_store_state', {store: 'SessionStore', state: {status: 'logged_in', user: 'Agente'}});
await sleep(500);
check((await call('wait_for', {condition: {type: 'view_match', filter: 'Hola Agente'}, timeoutMs: 5000})).matched, 'set_store_state re-renders the view');
await call('restore_stores', {snapshotId: snap.snapshotId});
check((await call('get_store_state', {store: 'CounterStore', path: '/count'})).state === 0, 'restore_stores brings the counter back');
await call('dispatch_action', {type: 'LOGIN_REQUESTED', payload: {userId: 2}, waitMs: 1000});
await call('call_plugin_method', {plugin: 'Databases', method: 'getTableInfo', params: {databaseId: 1, table: 'users'}}).catch(() => undefined);

console.log('\nLIVE OK');
await client.close();
