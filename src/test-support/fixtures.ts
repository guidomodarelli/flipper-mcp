import zlib from 'node:zlib';

/**
 * Plugin payloads shaped after the Flipper sources (desktop plugins and the
 * Android SDK, see PROTOCOL.md §3). Replace/extend with frames captured via
 * `flipper-mcp --record` from the real app (fixtures/recordings/*.jsonl).
 */
export const APP_ID = 'Demo#Android#Pixel_7#emulator-5554';

export const demoQuery = {
  app: 'Demo',
  app_id: 'com.example.demo',
  os: 'Android',
  device: 'Pixel_7',
  device_id: 'emulator-5554',
  sdk_version: 4,
  medium: 1,
};

export const device = {
  serial: 'emulator-5554',
  title: 'Pixel_7',
  os: 'Android',
  deviceType: 'emulator',
  features: {screenshotAvailable: true, screenCaptureAvailable: true},
  sdkVersion: '34',
};

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64');

export function newRequest(id: string, url: string, extra: {method?: string; body?: string; headers?: {key: string; value: string}[]} = {}) {
  return {
    id,
    timestamp: 1_000,
    method: extra.method ?? 'GET',
    url,
    headers: extra.headers ?? [{key: 'Accept', value: 'application/json'}],
    data: extra.body ? b64(extra.body) : null,
  };
}

export function newResponse(id: string, status: number, body: string, opts: {gzip?: boolean; timestamp?: number} = {}) {
  const headers = [{key: 'Content-Type', value: 'application/json; charset=utf-8'}];
  if (opts.gzip) headers.push({key: 'Content-Encoding', value: 'gzip'});
  return {
    id,
    timestamp: opts.timestamp ?? 1_120,
    status,
    reason: status === 200 ? 'OK' : 'Error',
    headers,
    data: b64(opts.gzip ? zlib.gzipSync(body) : body),
    isMock: false,
    insights: null,
  };
}

/** Splits a body into partialResponse messages (index 0 carries the response info). */
export function partialResponses(id: string, status: number, body: string, chunks: number) {
  const size = Math.ceil(body.length / chunks);
  const parts = Array.from({length: chunks}, (_, i) => body.slice(i * size, (i + 1) * size));
  return parts.map((part, index) =>
    index === 0
      ? {...newResponse(id, status, part), totalChunks: chunks, index: 0}
      : {id, totalChunks: chunks, index, data: b64(part)},
  );
}

export function logEntry(type: string, tag: string, message: string, pid = 4242) {
  return {
    serial: 'emulator-5554',
    entry: {date: new Date().toISOString(), type, tag, message, pid, tid: pid, app: undefined},
  };
}

/** ui-debugger metadata ids → attribute names (MetadataRegister on Android). */
export const uiMetadata = {
  attributeMetadata: {
    '1': {id: 1, type: 'attribute', namespace: 'View', name: 'View'},
    '2': {id: 2, type: 'attribute', namespace: 'View', name: 'visibility'},
    '10': {id: 10, type: 'attribute', namespace: 'TextView', name: 'TextView'},
    '11': {id: 11, type: 'attribute', namespace: 'TextView', name: 'text'},
  },
};

const node = (
  id: number,
  name: string,
  bounds: [number, number, number, number],
  children: number[],
  extra: Record<string, unknown> = {},
) => ({
  id,
  qualifiedName: `android.widget.${name}`,
  name,
  bounds: {x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3]},
  children,
  attributes: {},
  inlineAttributes: {},
  tags: ['Android', 'Native'],
  ...extra,
});

export const subtreeUpdate = {
  txId: 7,
  rootId: 1,
  snapshot: null,
  nodes: [
    node(1, 'DecorView', [0, 0, 1080, 2400], [2]),
    node(2, 'LinearLayout', [0, 100, 1080, 2300], [3, 4, 5], {parent: 1, inlineAttributes: {id: 'content'}}),
    node(3, 'TextView', [40, 20, 600, 80], [], {
      parent: 2,
      inlineAttributes: {id: 'title'},
      attributes: {'10': {type: 'object', fields: {'11': {type: 'text', value: 'Hola Flux'}}}},
    }),
    node(4, 'Button', [40, 200, 300, 120], [], {
      parent: 2,
      inlineAttributes: {id: 'login_button'},
      attributes: {'10': {type: 'object', fields: {'11': {type: 'text', value: 'Ingresar'}}}},
    }),
    node(5, 'ProgressBar', [40, 400, 100, 100], [], {parent: 2, hiddenAttributes: {invisible: true}}),
  ],
};

export const fluxAction = (type: string, traceId: string) => ({
  type,
  payload: {user: 'guido'},
  traceId,
  ts: 2_000,
  durationMs: 3,
  changes: [{store: 'SessionStore', diff: [{op: 'replace', path: '/status', value: 'loading', old: 'idle'}]}],
});
