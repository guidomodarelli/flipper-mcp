#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {loadConfig} from './config.js';
import {Debugger} from './Debugger.js';
import {Recorder} from './flipper/Recorder.js';
import {createMcpServer} from './mcp/server.js';

// stdout is the MCP channel: everything else goes to stderr.
const log = (message: string) => process.stderr.write(`[flipper-mcp] ${message}\n`);
console.log = (...args: unknown[]) => log(args.map(String).join(' '));
console.info = console.log;
console.warn = console.log;
console.debug = () => undefined;

async function main(): Promise<void> {
  const config = loadConfig();
  const recorder = config.recordPath ? new Recorder(config.recordPath) : undefined;
  if (recorder) log(`recording raw frames to ${recorder.filePath}`);

  const dbg = new Debugger(config, recorder);
  dbg.connection.on('state', (state) => log(`flipper-server ${state}${dbg.connection.lastError ? ` (${dbg.connection.lastError})` : ''}`));
  dbg.bridge.on('client-ready', (client) => log(`app ready: ${client.id} plugins=${client.plugins.join(',')}`));
  dbg.bridge.on('client-disconnected', (client) => log(`app disconnected: ${client.id}`));
  dbg.start();

  const server = createMcpServer(dbg);
  await server.connect(new StdioServerTransport());
  log(`connected to MCP client; flipper-server at ${dbg.connection.url}`);

  const shutdown = async () => {
    dbg.stop();
    await recorder?.close();
    await server.close();
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  log(`fatal: ${(error as Error).stack ?? error}`);
  process.exit(1);
});
