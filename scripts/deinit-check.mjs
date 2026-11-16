// Simulates the web UI switching plugins: sends `deinit` for ui-debugger and
// FluxDispatcher as a second WS client, then checks the MCP brings them back.
// Usage: node scripts/deinit-check.mjs   (flipper-server + sample app running)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

const token = fs.readFileSync(path.join(os.homedir(), '.flipper', 'certs', 'auth.token'), 'utf8').trim();
const transport = new StdioClientTransport({command: process.execPath, args: ['dist/index.js'], env: {...process.env}, stderr: 'ignore'});
const mcp = new Client({name: 'deinit-check', version: '0'});
await mcp.connect(transport);
const call = async (name, args = {}) => JSON.parse((await mcp.callTool({name, arguments: args})).content[0].text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app;
for (let i = 0; i < 30 && !app; i++) {
  app = (await call('list_apps')).apps.find((a) => a.ready);
  if (!app) await sleep(1000);
}
if (!app) throw new Error('no app ready');

const ui = new WebSocket(`ws://localhost:52342/?token=${token}`);
await new Promise((resolve) => ui.once('open', resolve));
let id = 0;
const exec = (command, args) => ui.send(JSON.stringify({event: 'exec', payload: {id: ++id, command, args}}));
for (const plugin of ['ui-debugger', 'FluxDispatcher']) exec('client-request', [app.id, {method: 'deinit', params: {plugin}}]);
console.log('deinit sent by the fake web UI');

const before = Date.now();
const result = await call('dispatch_action', {type: 'INCREMENT', payload: {by: 1}, waitMs: 3000});
console.log('dispatch_action after deinit:', JSON.stringify(result).slice(0, 300));
const wait = await call('wait_for', {condition: {type: 'view_match', filter: 'Count:'}, timeoutMs: 10000});
console.log(`ui-debugger frames back after ${Date.now() - before} ms:`, wait.matched);
ui.close();
await mcp.close();
if (!result.action || !wait.matched) process.exit(1);
console.log('DEINIT OK');
