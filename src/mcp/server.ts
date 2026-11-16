import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Debugger} from '../Debugger.js';
import {registerTools} from './tools.js';

export const SERVER_NAME = 'flipper-mcp';
export const SERVER_VERSION = '0.1.0';

export function createMcpServer(dbg: Debugger): McpServer {
  const server = new McpServer(
    {name: SERVER_NAME, version: SERVER_VERSION},
    {
      instructions:
        'Debug an Android app through Flipper. Start with list_apps. Events (network, logs, flux actions) are buffered from the moment this server started; query them with filters (since, afterId, limit) instead of asking for everything. Use wait_for after triggering an action instead of polling.',
    },
  );
  registerTools(server, dbg);
  return server;
}
