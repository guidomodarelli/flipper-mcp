# PROTOCOL.md — protocolo de Flipper que usa flipper-mcp

El protocolo entre la UI y `flipper-server` es interno y no está documentado. Esto se dedujo del
código de `facebook/flipper` (HEAD `1ce504a`, repo archivado) y de los paquetes npm **publicados**
`flipper-server@0.273.0`, `flipper-server-client@0.273.0` y `flipper-common@0.273.0`
(los últimos, del 2024-11-21). `npx flipper-server` instala 0.273.0, así que **cuando lo publicado
difiere de HEAD, manda lo publicado**.

> En HEAD, `flipper-server-core` y `flipper-frontend-core` ya no existen: se fusionaron en
> `desktop/flipper-server` y `desktop/flipper-ui`. El lado del SDK está en
> `xplat/Flipper/FlipperClient.cpp`.

Marcas: **[verificado]** = probado contra un `flipper-server@0.273.0` real;
**[código]** = deducido del código fuente, sin captura real todavía.

## 1. Transporte MCP ↔ flipper-server

- URL `ws://localhost:52342/?token=<JWT>`. Puerto por defecto `52342` (flag `--port` del server);
  path de upgrade `/` (`/hot` es de Metro; cualquier otro path se descarta). **[verificado]**
- Token: `~/.flipper/certs/auth.token` (en Windows `%USERPROFILE%\.flipper\certs\auth.token`). Es un
  JWT RS256 que vence a los 21 días; el server lo regenera, así que el MCP **relee el archivo en cada
  reconexión**. Token inválido → el upgrade responde `401`. **[verificado]**
  Alternativa: header `x-access-token`. Con `SKIP_TOKEN_VERIFICATION` en el server no se valida.
- Diferencia con HEAD (sin publicar): token por cookie `flipper_auth` + chequeo de loopback y de
  `Host`. Si algún día se corre un build de HEAD, hay que mandar `Cookie: flipper_auth=<token>`.
- `flipper-server-client@0.273.0`:
  - `createFlipperServer(host, port, tokenProvider, onState)` usa el `WebSocket` global, que
    Node 18 no tiene. El MCP usa `createFlipperServerWithSocket` con `reconnecting-websocket` + `ws`.
  - El timeout de `exec` es un `setInterval` que nunca se limpia cuando vence. El MCP le pasa el
    máximo (`2^31-1` ms) y aplica su propio timeout.
  - Si no conecta en 30 s, rechaza la promesa inicial y no hay forma de recuperar el objeto: el MCP
    descarta ese socket y abre uno nuevo.

### Sobres (un JSON por frame) **[verificado]**

Cliente → server:
```json
{"event":"exec","payload":{"id":1,"command":"device-list","args":[]}}
```
Server → cliente:
```json
{"event":"exec-response","payload":{"id":1,"data":<resultado>}}
{"event":"exec-response-error","payload":{"id":1,"data":"Error: ...\n<stack>"}}
{"event":"server-event","payload":{"event":"<nombre>","data":<payload>}}
{"event":"error","payload":{"message":"Failed to parse JSON request: ..."}}
```
`server-event` es broadcast (`server.onAny`) a **todos** los clientes WS: el MCP recibe lo mismo que
la UI web.

### Comandos `exec`

- `device-list` → `DeviceDescription[]` `{os, title, deviceType, serial, features, sdkVersion?}`. **[verificado]**
- `client-list` → `ClientDescription[]` `{id, query:{app, app_id?, os, device, device_id, sdk_version, medium}}`. **[verificado]** (vacío, sin app)
- `client-request(clientId, payload)` → `void`, fire-and-forget hacia la app. **[código]**
- `client-request-response(clientId, payload)` → `{success, length}` | `{error:{message, stacktrace, name}, length}`. **[código]**
- `device-shell-exec(serial, cmd)` → stdout (para `pidof <paquete>` en `get_logs onlyApp`). **[código]**

`clientId` = `escape(app)#os#device#device_id`, por ejemplo `MiApp#Android#Pixel_7#emulator-5554`.

### Eventos `server-event` que consume el MCP **[código]**

- `device-connected` / `device-disconnected` / `device-removed` → `DeviceDescription`
- `device-log` `{serial, entry:{date (ISO), type, message, pid, tid, tag, app?}}`, con
  `type ∈ unknown|verbose|debug|info|warn|error|fatal`. El server arranca logcat solo cuando se
  conecta el dispositivo.
- `device-crash` `{serial, crash:{name, reason, callstack}}` → el MCP lo guarda como log `fatal`
  con tag `flipper-crash`.
- `client-connected` → `ClientDescription`; `client-disconnected` `{id}`
- `client-setup-error` `{client, type, message}`
- `client-message` `{id: clientId, message: string}`: `message` es **JSON serializado** (ver §2).

## 2. Protocolo app ↔ desktop (dentro de `client-request*` y `client-message`) **[código]**

Desktop → app:
- `{"id":N,"method":"getPlugins"}` → `{"plugins":["Network","Databases",...]}`
- `{"id":N,"method":"getBackgroundPlugins"}` → `{"plugins":[...]}` (los `runInBackground()`)
- `{"method":"init","params":{"plugin":"Network"}}` → conecta el plugin. **Idempotente.** Error
  `PluginNotFound` si no existe.
- `{"method":"deinit","params":{"plugin":"X"}}` → desconecta el plugin **para todos los clientes**.
- `{"id":N,"method":"execute","params":{"api":"Databases","method":"databaseList","params":{}}}`.
  Error `ConnectionNotFound` si el plugin no está `init`.
- `{"id":N,"method":"isMethodSupported","params":{"api":"X","method":"y"}}` → `{"isSupported":bool}`

App → desktop (`client-message.message`, sin `id`):
- `{"method":"execute","params":{"api":"Network","method":"newRequest","params":{...}}}`
- `{"method":"refreshPlugins"}` → volver a hacer el handshake.
- `{"error":{...}}` → error del SDK.

### Riesgos de compartir la app con la UI web, y cómo los maneja el MCP

1. **Ids que chocan.** El server guarda las respuestas pendientes en un `Map` por `id` por conexión
   de app (`WebSocketClientConnection.pendingRequests`), compartido entre UI y MCP; la UI cuenta
   desde 0. → El MCP usa ids desde `2^40` (el SDK parsea `int64`).
2. **`deinit` ajeno.** Cuando el usuario cambia de plugin en la UI, la UI manda `deinit` y la app deja
   de emitir y de aceptar `execute` para todos. → El MCP manda `init` antes de cada `execute`, repite
   `init` cada `FLIPPER_REINIT_MS` para los plugins que escucha y, si recibe `ConnectionNotFound`,
   hace `init` y reintenta una vez.
3. **Replays.** Al `init`, `BufferingFlipperPlugin` (Network) reenvía su buffer. → Dedupe por
   `requestId`.
4. **Sin UI abierta.** El server solo acepta apps mientras haya ≥ 1 cliente WS
   (`startAcceptingNewConections`) y se apaga a las 5 h sin clientes. → El MCP cuenta como cliente y
   hace el handshake él mismo: `getPlugins` → `getBackgroundPlugins` → `init` de
   `FLIPPER_AUTO_INIT_PLUGINS`.

## 3. Mensajes por plugin **[código]**

### Network (`api: "Network"`, background)
- `newRequest` `{id, timestamp, method, url, headers:[{key,value}], data: base64|null}`
- `newResponse` `{id, timestamp, status, reason, headers, data: base64|null, isMock, insights?}`
- `partialResponse`: un `ResponseInfo` con `totalChunks>1, index:0` y chunks
  `{id, totalChunks, index>0, data}`. Llegan en cualquier orden y cada chunk es base64 por separado:
  se decodifican, se concatenan los bytes y después se descomprime.
- Body: base64 → inflar según `Content-Encoding` (`gzip`, `deflate`, `br`). Android a veces lo manda
  ya inflado: si inflar falla, se usan los bytes tal cual (igual que el plugin desktop).
- Correlación: el MCP toma el header `X-Flux-Trace-Id` (configurable con `FLIPPER_TRACE_HEADER`)
  como `traceId`.

### Databases (`api: "Databases"`)
- `databaseList({})` → `[{id:number, name, tables:string[]}]`
- `execute({databaseId, value: sql})` →
  `{type:'select'|'insert'|'update_delete', columns, values, insertedId, affectedCount}`; cada valor
  es `{type, value}` y el MCP lo aplana.
- También `getTableData`, `getTableStructure`, `getTableInfo` (no se usan; disponibles por
  `call_plugin_method`).

### Shared Preferences (`api: "Preferences"`)
- `getAllSharedPreferences({})` → `{[archivo]: {[clave]: valor}}`
- `setSharedPreference({sharedPreferencesName, preferenceName, preferenceValue})`,
  `deleteSharedPreference({sharedPreferencesName, preferenceName})`
- Evento `sharedPreferencesChange` `{preferences: archivo, name, time, deleted, value?}`

### Logs
No es un plugin de la app: es el evento `device-log` del server (§1).

### UI Debugger (`api: "ui-debugger"`, push)
- `init` `{rootId, frameworkEventMetadata?, supportedTraversalModes?, currentTraversalMode?}`
- `metadataUpdate` `{attributeMetadata: {[metadataId]: {id, type, namespace, name, mutable}}}`
- `subtreeUpdate` `{txId, rootId, nodes: ClientNode[], snapshot, frameworkEvents?}` y `frameScan`
  `{frameTime, nodes, snapshot?}`. Cada frame trae **todos** los nodos: reemplaza al anterior.
- `ClientNode = {id, parent?, qualifiedName, name, attributes, inlineAttributes, hiddenAttributes?, children, bounds, tags, activeChild?}`
- Del SDK de Android (`plugins/uidebugger/descriptors`):
  - `name` = `simpleName` de la clase; `qualifiedName` = nombre completo.
  - `bounds` es **relativo al padre** → el MCP suma los ancestros para dar coordenadas de pantalla.
  - `inlineAttributes.id` = nombre del resource id (solo si la vista tiene id).
  - `hiddenAttributes.invisible = true` cuando `visibility != VISIBLE`.
  - `attributes` = secciones por `metadataId` del namespace (por ejemplo `TextView`) con `fields`
    por `metadataId` del atributo (por ejemplo `text`); el nombre sale de `metadataUpdate`.
  - Si un padre tiene `activeChild`, los demás hijos no se ven (ViewPager, fragments).
- El Layout Inspector viejo (`api: "Inspector"`, `getRoot`/`getNodes`) no está soportado por
  `get_view_hierarchy`; se puede usar con `call_plugin_method`.

## 4. FluxDispatcher (fase 2, borrador) — plugin propio

`api: "FluxDispatcher"`, `runInBackground() = true` (para no perder acciones mientras la UI web
muestra otro plugin).

App → desktop:
- `action` `{seq, type, payload?, traceId, ts, durationMs, changes:[{store, diff}], error?}`
  - `diff`: operaciones estilo JSON Patch `{op: add|remove|replace, path, value?, old?}` entre el
    estado antes y después de cada store que cambió.
  - `traceId`: generado por acción; el interceptor de OkHttp lo agrega como `X-Flux-Trace-Id` a las
    requests que dispara esa acción.

Desktop → app (`execute`):
- `getStores({})` → `{stores: string[]}`
- `getStoreState({store})` → `{store, state}`
- `setStoreState({store, state})` → `{ok: true}`
- `dispatchAction({type, payload})` → `{traceId}`
- `snapshot({stores?})` → `{snapshotId, stores}`
- `restore({snapshotId})` → `{restored: string[]}`

El MCP ya consume `action` (buffer + `wait_for flux_action`). Las tools de fase 2 se agregan cuando
exista el plugin.

## 5. A capturar en vivo

`flipper-mcp --record <archivo.jsonl>` guarda cada frame WS crudo (`{t, dir, frame}`). Lo que hay que
capturar con la app real y dejar en `fixtures/recordings/` (los tests de replay lo toman solos):

- Un handshake completo: `getPlugins`/`getBackgroundPlugins` con sus respuestas.
- Mensajes reales de Network (incluyendo bodies gzip y, si aparecen, `partialResponse`).
- `metadataUpdate` + `subtreeUpdate` de ui-debugger, para confirmar dónde quedan `text`, `visibility`
  y el resource id en tu versión del SDK.
- `device-log` y, si se puede, un `device-crash`.

Alternativa sin el MCP: DevTools de la UI web → Network → WS → Messages.
