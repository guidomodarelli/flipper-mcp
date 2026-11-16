# flipper-mcp

Servidor MCP para que un agente de IA depure una app Android usando [Flipper](https://github.com/facebook/flipper).
Se conecta a un `flipper-server` que ya esté corriendo (`npx flipper-server`, la UI web) como un
cliente más, acumula en memoria los eventos que la app empuja (red, logs, cambios de preferencias,
vistas, acciones Flux) y los expone como tools con filtros y salida JSON compacta.

- Protocolo usado: [PROTOCOL.md](PROTOCOL.md).
- Flipper está archivado: las versiones están fijadas a `flipper-server-client@0.273.0` /
  `flipper-common@0.273.0`, que es lo que instala `npx flipper-server` hoy.

## Requisitos

- Node.js ≥ 18 para correr el servidor (el desarrollo y los tests usan el Node de `.nvmrc`).
- `flipper-server` 0.273.0 corriendo: `npx flipper-server` (abre la UI en `http://localhost:52342`).
  Al arrancar por primera vez crea el token en `~/.flipper/certs/auth.token`.
- La app con el SDK de Flipper en el build debug. Para la jerarquía de vistas, el plugin
  **UI Debugger** (ver [Configurar la app](#configurar-la-app)).

## Instalación

```bash
git clone https://github.com/guidomodarelli/flipper-mcp.git
cd flipper-mcp
pnpm install   # compila a dist/ en el prepare
```

## Configurarlo en un cliente MCP

El servidor usa stdio. Los clientes MCP **no le pasan tu entorno** al proceso: las variables van en
la config del cliente.

**Claude Code**

```bash
claude mcp add flipper -- node /ruta/a/flipper-mcp/dist/index.js
# con variables:
claude mcp add flipper -e FLIPPER_PORT=52342 -- node /ruta/a/flipper-mcp/dist/index.js
```

**Cursor** (`.cursor/mcp.json`) y cualquier cliente con el formato `mcpServers`:

```json
{
  "mcpServers": {
    "flipper": {
      "command": "node",
      "args": ["/ruta/a/flipper-mcp/dist/index.js"],
      "env": {"FLIPPER_HOST": "localhost", "FLIPPER_PORT": "52342"}
    }
  }
}
```

En Windows usá rutas con `/` o `\\` escapadas (`C:/Users/vos/flipper-mcp/dist/index.js`).

El proceso es persistente: arranca con el cliente MCP, se conecta al server y **empieza a guardar
eventos desde ese momento**. Lo que pasó antes no se ve. Si `flipper-server` o la app se caen, se
reconecta solo.

## Variables de entorno

| Variable | Default | Para qué |
| --- | --- | --- |
| `FLIPPER_HOST` | `localhost` | Host del `flipper-server`. |
| `FLIPPER_PORT` | `52342` | Puerto del `flipper-server` (también `--port`). |
| `FLIPPER_TOKEN_PATH` | `~/.flipper/certs/auth.token` | Token JWT; se relee en cada reconexión. |
| `FLIPPER_TOKEN` | — | Token explícito (tiene prioridad sobre el archivo). |
| `FLIPPER_LOG_BUFFER` | `5000` | Líneas de logcat guardadas. |
| `FLIPPER_NETWORK_BUFFER` | `500` | Requests HTTP guardadas. |
| `FLIPPER_FLUX_BUFFER` | `1000` | Acciones Flux guardadas. |
| `FLIPPER_PREFS_BUFFER` | `500` | Cambios de SharedPreferences guardados. |
| `FLIPPER_BODY_PREVIEW_BYTES` | `2048` | Tamaño de los bodies si no se pide `full=true`. |
| `FLIPPER_MAX_BODY_BYTES` | `1048576` | Bodies más grandes no se guardan (solo su tamaño). |
| `FLIPPER_LOG_MAX_CHARS` | `1000` | Corte de cada mensaje de log. |
| `FLIPPER_TRACE_HEADER` | `X-Flux-Trace-Id` | Header HTTP que se toma como `traceId`. |
| `FLIPPER_AUTO_INIT_PLUGINS` | `Network,Preferences,ui-debugger,FluxDispatcher` | Plugins que el MCP activa al conectarse la app. |
| `FLIPPER_REINIT_MS` | `5000` | Cada cuánto re-activa esos plugins (la UI web los desactiva al cambiar de pestaña). |
| `FLIPPER_EXEC_TIMEOUT_MS` | `15000` | Timeout de cada comando al server. |
| `FLIPPER_RECORD` | — | Archivo JSONL donde grabar cada frame WS (también `--record`). |

## Tools

Todas aceptan `app` (id de `list_apps`, nombre o paquete); se puede omitir si hay una sola app.
Los tiempos (`since`, `until`, `changesSince`) aceptan epoch ms, relativos (`"30s"`, `"5m"`, `"1h"`)
o ISO. Las listas devuelven `{items, matched, truncated, lastId}`: pasá `lastId` como `afterId` para
traer solo lo nuevo.

| Tool | Qué devuelve |
| --- | --- |
| `list_devices` | Estado de la conexión, uso de buffers y dispositivos. |
| `list_apps` | Apps conectadas, sus plugins y errores del handshake. |
| `get_network_requests` | Requests sin bodies. Filtros: `url` (substring o `/regex/`), `method`, `status` (`404`, `"4xx"`, `"error"`, `"ok"`, `"pending"`), `traceId`, `since`, `until`, `afterId`, `limit`. |
| `get_network_request` | Headers y bodies decodificados (base64 + gzip/br) de una request; truncados salvo `full=true`. |
| `get_view_hierarchy` | Árbol podado del UI Debugger: `id, cls, text, desc, resId, b=[x,y,w,h]` en px de pantalla. `maxDepth`, `maxNodes`, `rootId`, `includeHidden`; con `filter` devuelve una lista plana con el `path`. |
| `get_logs` | Logcat. `level` (mínimo), `tag`, `grep`, `pid`, `onlyApp` (proceso de la app), `traceId`, tiempos, `limit`. Los crashes aparecen como `fatal` con tag `flipper-crash`. |
| `list_databases` / `query_database` | Bases SQLite del plugin Databases; `query_database(db, sql, maxRows)` con valores aplanados. **Las escrituras se aplican.** |
| `get_shared_preferences` | Estado actual (todos los archivos o `file`), o con `changesSince`/`afterId` solo los cambios. |
| `wait_for` | Espera `network_idle`, `network_request(url)`, `log_match(regex)` o `flux_action(actionType)`; devuelve el evento o `{matched:false, hint}`. |
| `call_plugin_method` | Llama cualquier método de cualquier plugin y devuelve la respuesta cruda. |

Los errores vienen con `isError` y un mensaje que dice qué hacer, por ejemplo
`No app connected to flipper-server. Devices available: ["Pixel_7 (emulator-5554)"]. …`.

## Configurar la app

Recomendado: SDK de Flipper **0.273.0** (el último publicado; coincide con el server) y el plugin
**UI Debugger** en lugar del Layout Inspector viejo (`InspectorFlipperPlugin`), que está deprecado y
no lo soporta `get_view_hierarchy`.

```kotlin
// build.gradle (debug)
debugImplementation("com.facebook.flipper:flipper:0.273.0")
debugImplementation("com.facebook.soloader:soloader:0.10.4")
debugImplementation("com.facebook.flipper:flipper-network-plugin:0.273.0")

// Application.onCreate, solo en debug
SoLoader.init(this, false)
if (FlipperUtils.shouldEnableFlipper(this)) {
  val client = AndroidFlipperClient.getInstance(this)
  client.addPlugin(UIDebuggerFlipperPlugin(UIDContext.create(this)))
  client.addPlugin(NetworkFlipperPlugin().also { networkPlugin = it }) // + FlipperOkhttpInterceptor(networkPlugin)
  client.addPlugin(DatabasesFlipperPlugin(this))
  client.addPlugin(SharedPreferencesFlipperPlugin(this))
  client.start()
}
```

## Grabar tráfico real

```bash
node dist/index.js --record recordings/sesion.jsonl
```

Cada línea es `{t, dir: "in"|"out", frame}`. Copiá la grabación a `fixtures/recordings/` y
`pnpm test` la reproduce contra el server falso (`src/replay.test.ts`).

## Desarrollo

```bash
pnpm typecheck
pnpm test        # unitarios (buffers, filtros) + integración con un flipper-server falso
pnpm build
node scripts/smoke.mjs   # contra un flipper-server real en localhost:52342
```

- `src/flipper/` — conexión (`FlipperConnection`), protocolo de apps (`FlipperBridge`), grabación.
- `src/stores/` — un store por fuente de eventos, sobre `src/buffer/RingBuffer.ts`.
- `src/mcp/` — definición de las tools.
- `src/test-support/` — `FakeFlipperServer` (mismos sobres que 0.273.0) y fixtures.

## Estado

- Fase 1 (MVP): las tools de arriba.
- Fase 2: plugin Android `FluxDispatcher` y tools `get_flux_actions`, `get_store_state`,
  `dispatch_action`, `snapshot_stores`, `restore_stores`. El MCP ya guarda las acciones `action`
  que emita el plugin (protocolo en [PROTOCOL.md §4](PROTOCOL.md#4-fluxdispatcher-fase-2-borrador--plugin-propio)).
