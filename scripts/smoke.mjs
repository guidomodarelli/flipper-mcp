// Smoke test against a real flipper-server: spawns the built MCP over stdio.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const record = process.argv[2];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js', ...(record ? ['--record', record] : [])],
  stderr: 'inherit',
  env: {...process.env},
});
const client = new Client({name: 'smoke', version: '0.0.0'});
await client.connect(transport);
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
await new Promise((r) => setTimeout(r, 1500));
for (const [name, args] of [
  ['list_devices', {}],
  ['list_apps', {}],
  ['get_logs', {limit: 3}],
  ['get_network_requests', {}],
  ['get_view_hierarchy', {}],
  ['wait_for', {condition: {type: 'log_match', regex: 'never'}, timeoutMs: 300}],
]) {
  const result = await client.callTool({name, arguments: args});
  console.log(`${name}${result.isError ? ' (error)' : ''}:`, result.content[0].text);
}
await client.close();
