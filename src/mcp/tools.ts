import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {truncate} from '../buffer/filters.js';
import {ActionableError, type Debugger} from '../Debugger.js';

type ToolResult = {content: {type: 'text'; text: string}[]; isError?: boolean};

/** Compact JSON: no indentation, no undefined fields. */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

async function run(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return {content: [{type: 'text', text: toJson(value)}]};
  } catch (error) {
    const body =
      error instanceof ActionableError
        ? {error: error.message, ...error.details}
        : {error: (error as Error).message ?? String(error)};
    return {content: [{type: 'text', text: toJson(body)}], isError: true};
  }
}

const app = z
  .string()
  .optional()
  .describe('Target app: client id from list_apps, app name or package. Optional when only one app is connected.');
const since = z
  .union([z.string(), z.number()])
  .optional()
  .describe('Lower time bound: epoch ms, relative like "30s"/"5m"/"1h", or ISO date.');
const until = z.union([z.string(), z.number()]).optional().describe('Upper time bound, same formats as since.');
const afterId = z
  .number()
  .int()
  .optional()
  .describe('Only events with id greater than this; pass the previous lastId to poll incrementally.');
const limit = (def: number, max: number) =>
  z.number().int().min(1).max(max).optional().describe(`Max events (newest kept). Default ${def}.`);

/** Resolves an RFC 6901 JSON pointer. */
export function pointer(value: unknown, path: string): unknown {
  if (path === '' || path === '/') return value;
  if (!path.startsWith('/')) throw new ActionableError(`path must be a JSON pointer starting with "/", got "${path}".`);
  let current: unknown = value;
  for (const raw of path.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !(key in (current as object))) {
      throw new ActionableError(`Nothing at ${path} in the store state (missing "${key}").`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

type DbValue = {type: string; value: unknown};
const flatten = (value: unknown) =>
  value && typeof value === 'object' && 'type' in value ? (value as DbValue).value : value;

export function registerTools(server: McpServer, dbg: Debugger): void {
  server.registerTool(
    'list_devices',
    {
      title: 'List devices',
      description: 'flipper-server connection state, buffer usage and the devices it sees (emulators, phones).',
      inputSchema: {},
      annotations: {readOnlyHint: true},
    },
    () => run(() => dbg.listDevices()),
  );

  server.registerTool(
    'list_apps',
    {
      title: 'List apps',
      description: 'Apps connected to flipper-server with their Flipper plugins. Use the id as `app` in other tools.',
      inputSchema: {},
      annotations: {readOnlyHint: true},
    },
    () => run(() => dbg.listApps()),
  );

  server.registerTool(
    'get_network_requests',
    {
      title: 'Query HTTP requests',
      description:
        'HTTP requests captured by the Network plugin since the MCP started, oldest→newest, without bodies. Use get_network_request(id) for headers and body.',
      inputSchema: {
        app,
        url: z.string().optional().describe('Substring or /regex/ on the URL.'),
        method: z.string().optional(),
        status: z
          .union([z.string(), z.number()])
          .optional()
          .describe('404, "4xx", "error" (>=400 or failed), "ok" or "pending".'),
        traceId: z.string().optional(),
        since,
        until,
        afterId,
        limit: limit(50, 500),
      },
      annotations: {readOnlyHint: true},
    },
    (args) =>
      run(() => {
        const client = dbg.optionalClient(args.app);
        return dbg.network.query({...args, clientId: args.app ? client?.id : undefined});
      }),
  );

  server.registerTool(
    'get_network_request',
    {
      title: 'Get one HTTP request',
      description: 'Headers and decoded bodies of one request. Bodies are truncated unless full=true.',
      inputSchema: {
        id: z.union([z.number(), z.string()]).describe('Event id from get_network_requests, or the plugin requestId.'),
        app,
        full: z.boolean().optional().describe('Return complete bodies.'),
        maxBodyBytes: z.number().int().min(16).optional().describe('Preview size per body when full is false.'),
        headers: z.boolean().optional().describe('Include headers (default true).'),
      },
      annotations: {readOnlyHint: true},
    },
    (args) =>
      run(() => {
        const client = args.app ? dbg.optionalClient(args.app) : undefined;
        const entry = dbg.network.find(args.id, client?.id);
        if (!entry) {
          throw new ActionableError(
            `No request with id ${args.id} in the buffer (it may have been evicted; buffer holds ${dbg.network.buffer.capacity}).`,
          );
        }
        return dbg.network.detail(entry, args);
      }),
  );

  server.registerTool(
    'get_view_hierarchy',
    {
      title: 'Get view hierarchy',
      description:
        'Latest UI tree from the ui-debugger plugin, pruned: id, cls, text, desc, resId, b=[x,y,w,h] in absolute screen px. Hidden views are omitted unless includeHidden. With filter, returns a flat list of matching nodes with their ancestor path.',
      inputSchema: {
        app,
        maxDepth: z.number().int().min(1).max(100).optional().describe('Default 12.'),
        filter: z.string().optional().describe('Substring or /regex/ on class, resource id, text or content description.'),
        rootId: z.union([z.number(), z.string()]).optional().describe('Start from this node id.'),
        includeHidden: z.boolean().optional(),
        maxNodes: z.number().int().min(1).max(5000).optional().describe('Default 300.'),
      },
      annotations: {readOnlyHint: true},
    },
    (args) => run(() => dbg.viewHierarchy(args.app, args)),
  );

  server.registerTool(
    'get_logs',
    {
      title: 'Query device logs',
      description: 'Logcat entries received since the MCP started (crashes appear as level fatal, tag flipper-crash).',
      inputSchema: {
        app: z
          .string()
          .optional()
          .describe('Restrict to the device of this app; with onlyApp=true also to its process.'),
        onlyApp: z.boolean().optional().describe('Only the app process (resolved with pidof on the device).'),
        level: z.enum(['verbose', 'debug', 'info', 'warn', 'error', 'fatal']).optional().describe('Minimum level.'),
        tag: z.string().optional().describe('Substring or /regex/ on the tag.'),
        grep: z.string().optional().describe('Substring or /regex/ on the message.'),
        pid: z.number().int().optional(),
        traceId: z.string().optional(),
        since,
        until,
        afterId,
        limit: limit(100, 2000),
      },
      annotations: {readOnlyHint: true},
    },
    (args) =>
      run(async () => {
        let serial: string | undefined;
        let pid = args.pid;
        if (args.app || args.onlyApp) {
          const client = dbg.resolveClient(args.app, {requireConnected: false});
          serial = client.deviceId;
          if (args.onlyApp) {
            const pkg = client.appId ?? client.app;
            const out = await dbg.connection.exec<string>('device-shell-exec', [serial, `pidof ${pkg}`]);
            const found = Number.parseInt(String(out).trim().split(/\s+/)[0] ?? '', 10);
            if (Number.isNaN(found)) throw new ActionableError(`Could not resolve the pid of ${pkg} (is it running?).`);
            pid = found;
          }
        }
        return dbg.logs.query({...args, serial, pid});
      }),
  );

  server.registerTool(
    'list_databases',
    {
      title: 'List databases',
      description: 'SQLite databases exposed by the Databases plugin, with their tables.',
      inputSchema: {app},
      annotations: {readOnlyHint: true},
    },
    (args) => run(() => dbg.callPlugin(args.app, 'Databases', 'databaseList', {})),
  );

  server.registerTool(
    'query_database',
    {
      title: 'Run SQL',
      description: 'Runs SQL on an app database through the Databases plugin. Writes are applied to the real database.',
      inputSchema: {
        app,
        db: z.union([z.number(), z.string()]).describe('Database id or (part of the) name from list_databases.'),
        sql: z.string().min(1),
        maxRows: z.number().int().min(1).max(5000).optional().describe('Default 100.'),
      },
      annotations: {readOnlyHint: false, destructiveHint: true},
    },
    (args) =>
      run(async () => {
        const databases = await dbg.callPlugin<{id: number; name: string; tables: string[]}[]>(
          args.app,
          'Databases',
          'databaseList',
          {},
        );
        const wanted = String(args.db).toLowerCase();
        const exact = databases.filter((d) => String(d.id) === wanted || d.name.toLowerCase() === wanted);
        const partial = databases.filter((d) => d.name.toLowerCase().includes(wanted));
        const candidates = exact.length ? exact : partial;
        if (candidates.length !== 1) {
          throw new ActionableError(
            candidates.length > 1 ? `"${args.db}" matches several databases.` : `No database "${args.db}".`,
            {databases: databases.map((d) => ({id: d.id, name: d.name}))},
          );
        }
        const database = candidates[0]!;
        const result = await dbg.callPlugin<{
          type: string;
          columns?: string[];
          values?: unknown[][];
          insertedId?: number;
          affectedCount?: number;
        }>(args.app, 'Databases', 'execute', {databaseId: database.id, value: args.sql});
        const maxRows = args.maxRows ?? 100;
        const rows = (result.values ?? []).map((row) => row.map(flatten));
        return {
          db: database.name,
          type: result.type,
          ...(result.type === 'select'
            ? {
                columns: result.columns,
                rows: rows.slice(0, maxRows),
                rowCount: rows.length,
                ...(rows.length > maxRows ? {truncated: true} : {}),
              }
            : {insertedId: result.insertedId, affectedCount: result.affectedCount}),
        };
      }),
  );

  server.registerTool(
    'get_shared_preferences',
    {
      title: 'Get SharedPreferences',
      description:
        'Current SharedPreferences (all files or one). With changesSince, returns only the changes pushed since then (a diff) instead of the full state.',
      inputSchema: {
        app,
        file: z.string().optional().describe('Preferences file name (substring match).'),
        changesSince: since,
        afterId,
      },
      annotations: {readOnlyHint: true},
    },
    (args) =>
      run(async () => {
        if (args.changesSince !== undefined || args.afterId !== undefined) {
          const client = dbg.resolveClient(args.app, {requireConnected: false});
          return dbg.prefs.changes({clientId: client.id, file: args.file, since: args.changesSince, afterId: args.afterId});
        }
        const all = await dbg.callPlugin<Record<string, Record<string, unknown>>>(
          args.app,
          'Preferences',
          'getAllSharedPreferences',
          {},
        );
        if (!args.file) return all;
        const needle = args.file.toLowerCase();
        const picked = Object.fromEntries(Object.entries(all).filter(([name]) => name.toLowerCase().includes(needle)));
        if (Object.keys(picked).length === 0) {
          throw new ActionableError(`No preferences file matches "${args.file}".`, {files: Object.keys(all)});
        }
        return picked;
      }),
  );

  server.registerTool(
    'wait_for',
    {
      title: 'Wait for a condition',
      description:
        'Blocks until a condition happens after the call, or the timeout. Returns {matched, waitedMs, event?, hint?}. Conditions: network_idle (no pending requests and no traffic for idleMs), network_request (a response for a matching URL), log_match (regex on new log messages), flux_action (new Flux action whose type matches), view_match (a visible view matching filter in the latest UI frame).',
      inputSchema: {
        app,
        condition: z.discriminatedUnion('type', [
          z.object({
            type: z.literal('network_idle'),
            idleMs: z.number().int().min(50).optional().describe('Default 1000.'),
            url: z.string().optional().describe('Only consider requests whose URL matches.'),
          }),
          z.object({
            type: z.literal('network_request'),
            url: z.string().describe('Substring or /regex/.'),
            method: z.string().optional(),
          }),
          z.object({
            type: z.literal('log_match'),
            regex: z.string().describe('JavaScript regex, case-insensitive.'),
            tag: z.string().optional(),
          }),
          z.object({
            type: z.literal('view_match'),
            filter: z.string().describe('Same as get_view_hierarchy filter: substring or /regex/ on class, resId, text, desc.'),
          }),
          z.object({
            type: z.literal('flux_action'),
            actionType: z.string().describe('Substring or /regex/ on the action type.'),
          }),
        ]),
        timeoutMs: z.number().int().min(100).max(300_000).optional().describe('Default 10000.'),
      },
      annotations: {readOnlyHint: true},
    },
    (args) => run(() => dbg.waitFor(args.condition, args.timeoutMs ?? 10_000, args.app)),
  );

  // ---- Phase 2: FluxDispatcher plugin ----

  server.registerTool(
    'get_flux_actions',
    {
      title: 'Query Flux actions',
      description:
        'Flux actions dispatched in the app since the MCP started, with the stores each one changed and their diffs (JSON-Patch ops). Requires the FluxDispatcher plugin.',
      inputSchema: {
        app,
        type: z.string().optional().describe('Substring or /regex/ on the action type.'),
        store: z.string().optional().describe('Only actions that changed this store.'),
        traceId: z.string().optional(),
        includePayload: z.boolean().optional().describe('Default false.'),
        includeDiff: z.boolean().optional().describe('Default true.'),
        since,
        until,
        afterId,
        limit: limit(50, 500),
      },
      annotations: {readOnlyHint: true},
    },
    (args) =>
      run(() => {
        const client = dbg.optionalClient(args.app);
        return dbg.flux.query({...args, clientId: args.app ? client?.id : undefined});
      }),
  );

  server.registerTool(
    'get_store_state',
    {
      title: 'Get Flux store state',
      description: 'Current state of a Flux store, optionally only the subtree at a JSON pointer. Without store, lists the stores.',
      inputSchema: {
        app,
        store: z.string().optional(),
        path: z.string().optional().describe('JSON pointer inside the state, e.g. "/user/email".'),
      },
      annotations: {readOnlyHint: true},
    },
    (args) =>
      run(async () => {
        if (!args.store) return dbg.fluxCall<{stores: string[]}>(args.app, 'getStores');
        const {state} = await dbg.fluxCall<{store: string; state: unknown}>(args.app, 'getStoreState', {store: args.store});
        return {store: args.store, ...(args.path ? {path: args.path} : {}), state: args.path ? pointer(state, args.path) : state};
      }),
  );

  server.registerTool(
    'set_store_state',
    {
      title: 'Replace Flux store state',
      description: 'Replaces the whole state of a store (listeners are notified, the UI re-renders). Take a snapshot_stores first to undo.',
      inputSchema: {app, store: z.string(), state: z.record(z.string(), z.unknown())},
      annotations: {readOnlyHint: false, destructiveHint: true},
    },
    (args) => run(() => dbg.fluxCall(args.app, 'setStoreState', {store: args.store, state: args.state})),
  );

  server.registerTool(
    'dispatch_action',
    {
      title: 'Dispatch a Flux action',
      description:
        'Dispatches an action in the app. Returns its traceId and, after up to waitMs, the resulting store diffs and the HTTP requests it started (same traceId).',
      inputSchema: {
        app,
        type: z.string(),
        payload: z.record(z.string(), z.unknown()).optional(),
        waitMs: z.number().int().min(0).max(30_000).optional().describe('Default 2000; 0 returns right after dispatching.'),
      },
      annotations: {readOnlyHint: false},
    },
    (args) => run(() => dbg.dispatchAction(args.app, args.type, args.payload ?? {}, args.waitMs ?? 2000)),
  );

  server.registerTool(
    'snapshot_stores',
    {
      title: 'Snapshot Flux stores',
      description: 'Saves the state of all stores (or the given ones) in the app. Use restore_stores with the snapshotId to go back.',
      inputSchema: {app, stores: z.array(z.string()).optional()},
      annotations: {readOnlyHint: true},
    },
    (args) => run(() => dbg.fluxCall(args.app, 'snapshot', args.stores ? {stores: args.stores} : {})),
  );

  server.registerTool(
    'restore_stores',
    {
      title: 'Restore Flux stores',
      description: 'Restores the stores saved by snapshot_stores. Snapshots live in the app process and are lost when it restarts.',
      inputSchema: {app, snapshotId: z.string()},
      annotations: {readOnlyHint: false, destructiveHint: true},
    },
    (args) => run(() => dbg.fluxCall(args.app, 'restore', {snapshotId: args.snapshotId})),
  );

  server.registerTool(
    'call_plugin_method',
    {
      title: 'Call any plugin method',
      description:
        'Generic escape hatch: calls method on a Flipper plugin of the app (execute{api, method, params}) and returns its raw reply. Plugin names come from list_apps.',
      inputSchema: {
        app,
        plugin: z.string(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        timeoutMs: z.number().int().min(100).max(120_000).optional(),
        maxChars: z.number().int().min(100).optional().describe('Truncate the JSON reply (default 20000).'),
      },
      annotations: {readOnlyHint: false},
    },
    (args) =>
      run(async () => {
        const reply = await dbg.callPlugin(args.app, args.plugin, args.method, args.params ?? {}, args.timeoutMs);
        const text = JSON.stringify(reply) ?? 'null';
        const max = args.maxChars ?? 20_000;
        if (text.length <= max) return reply;
        return {truncated: true, chars: text.length, preview: truncate(text, max).text};
      }),
  );
}
