// Polls list_devices every 2 s for N seconds, to watch reconnection against a real flipper-server.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const seconds = Number(process.argv[2] ?? 40);
const transport = new StdioClientTransport({command: process.execPath, args: ['dist/index.js'], env: {...process.env}, stderr: 'inherit'});
const client = new Client({name: 'watch', version: '0.0.0'});
await client.connect(transport);
for (let t = 0; t < seconds; t += 2) {
  await new Promise((r) => setTimeout(r, 2000));
  const result = await client.callTool({name: 'list_devices', arguments: {}});
  const body = JSON.parse(result.content[0].text);
  console.log(`t=${t + 2}s state=${body.server.state} devices=${body.devices.length} lastError=${body.server.lastError ?? '-'}`);
}
await client.close();
