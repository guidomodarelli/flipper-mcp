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
| `wait_for` | Espera `network_idle`, `network_request(url)`, `log_match(regex)`, `flux_action(actionType)` o `view_match(filter)` (una vista visible en el último frame); devuelve el evento o `{matched:false, hint}`. |
| `call_plugin_method` | Llama cualquier método de cualquier plugin y devuelve la respuesta cruda. |

Con el plugin `FluxDispatcher` en la app (fase 2):

| Tool | Qué devuelve |
| --- | --- |
| `get_flux_actions` | Acciones despachadas, con los stores que cambió cada una y su diff (ops estilo JSON Patch). Filtros: `type`, `store`, `traceId`, tiempos, `afterId`, `limit`; `includePayload`. |
| `get_store_state` | Estado actual de un store, o solo el subárbol de `path` (JSON pointer). Sin `store`, la lista de stores. |
| `set_store_state` | Reemplaza el estado de un store; la UI se vuelve a renderizar. |
| `dispatch_action` | Despacha `type` + `payload` y devuelve el `traceId`, el diff resultante y las requests con ese `traceId`. |
| `snapshot_stores` / `restore_stores` | Guarda el estado de los stores y lo restaura (los snapshots viven en el proceso de la app). |

Los errores vienen con `isError` y un mensaje que dice qué hacer, por ejemplo
`No app connected to flipper-server. Devices available: ["Pixel_7 (emulator-5554)"]. …`.

El `traceId` une Action → request HTTP → cambio de store: la request lleva el header
`X-Flux-Trace-Id` y la acción de respuesta se despacha con el mismo id (ver `android/sample`).

## Configurar la app

Recomendado: SDK de Flipper **0.273.0** (el último publicado; coincide con el server) y el plugin
**UI Debugger** en lugar del Layout Inspector viejo (`InspectorFlipperPlugin`), que está deprecado y
no lo soporta `get_view_hierarchy`.

```kotlin
// build.gradle.kts: todo solo en debug
debugImplementation("com.facebook.flipper:flipper:0.273.0")
debugImplementation("com.facebook.flipper:flipper-network-plugin:0.273.0")
debugImplementation("com.facebook.soloader:soloader:0.10.4")
debugImplementation(project(":flux-flipper"))   // android/flux-flipper de este repo

// src/debug/…/DebugTools.kt
SoLoader.init(app, false)
if (FlipperUtils.shouldEnableFlipper(app)) {
  val network = NetworkFlipperPlugin()           // + addNetworkInterceptor(FlipperOkhttpInterceptor(network))
  val flux = FluxDispatcherFlipperPlugin(
    stores = listOf(FluxStoreBinding("SessionStore", SessionState::class.java, { sessionStore.state }, sessionStore::replaceState)),
    dispatchAction = { type, payloadJson -> dispatcher.dispatch(actionFrom(type, payloadJson)) },
  )
  dispatcher.interceptor = DispatchInterceptor { action, proceed -> flux.trace(action.type, action.payload, proceed) }
  AndroidFlipperClient.getInstance(app).apply {
    addPlugin(UIDebuggerFlipperPlugin(UIDContext.create(app)))
    addPlugin(network)
    addPlugin(DatabasesFlipperPlugin(app))
    // Listá los archivos: si no, el plugin solo ve los que ya existen al arrancar.
    addPlugin(SharedPreferencesFlipperPlugin(app, listOf(SharedPreferencesDescriptor("session_prefs", MODE_PRIVATE))))
    addPlugin(flux)
    start()
  }
}
// src/release/…/DebugTools.kt: la misma API sin Flipper.
```

Para un Dispatcher propio solo hacen falta dos ganchos:

1. **Envolver cada dispatch** con `flux.trace(type, payload) { … }`. Toma el estado de los stores
   antes y después y manda la acción con el diff y el `traceId`.
2. **Propagar el `traceId`**: `FluxTrace.current()` dentro del dispatch, agregarlo como header
   `FluxTrace.HEADER` a la request, y despachar la respuesta dentro de `FluxTrace.runWith(id) { … }`
   **en el hilo donde se despacha** (si el Dispatcher hace `post` al main thread, el `runWith` va
   dentro del `post`, porque es un `ThreadLocal`).

El estado se serializa con Gson (`FluxStoreBinding.stateClass` se usa para `set_store_state` y
`restore_stores`; sin `setState` el store es de solo lectura). Un ejemplo completo y probado está en
[`android/sample`](android/sample) (Dispatcher, Actions, Stores y Views al estilo Flux).

## Probar con un emulador

Lo que se usó para validar todo de punta a punta en Windows:

1. JDK 17, Android SDK (`platform-tools`, `emulator`, `platforms;android-34`,
   `system-images;android-34;google_apis;x86_64`) en `%LOCALAPPDATA%\Android\Sdk`, que es donde
   `flipper-server` busca `adb` por defecto, y un AVD:
   `avdmanager create avd -n flipper34 -k "system-images;android-34;google_apis;x86_64" -d pixel_6`.
2. **OpenSSL 1.1.1 para `flipper-server`.** Con el OpenSSL 3.5 que trae Git for Windows el
   intercambio de certificados falla con `X509_REQ_verify_ex:unsupported version` y la app nunca
   conecta: OpenSSL 3.5 rechaza la versión del CSR que genera el SDK. Con 1.1.1w funciona (no probé
   versiones intermedias). Poné OpenSSL 1.1.1 primero en el `PATH` del server, con su `OPENSSL_CONF`:
   ```bash
   export PATH="/ruta/openssl-1.1/x64/bin:$PATH" OPENSSL_CONF="/ruta/openssl-1.1/ssl/openssl.cnf"
   npx flipper-server@0.273.0
   ```
3. `cd android && ./gradlew :sample:installDebug`, con el emulador corriendo.
4. `pnpm build && ADB=<ruta a adb> node scripts/live.mjs recordings/live.jsonl`: reinicia la app,
   toca botones con las coordenadas que devuelve `get_view_hierarchy` y recorre todas las tools con
   chequeos (correlación por `traceId`, texto de las vistas, preferencias, `dispatch_action`,
   `set_store_state`, snapshot/restore).
5. `node scripts/deinit-check.mjs`: simula que la UI web desactiva `ui-debugger` y
   `FluxDispatcher` y verifica que el MCP los vuelve a activar.

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
- `android/flux-flipper` — plugin `FluxDispatcher` (Kotlin); `cd android && ./gradlew :flux-flipper:testDebugUnitTest`.
- `android/sample` — app Flux de ejemplo con Flipper solo en debug.

## Estado

- Fase 1 (MVP) y fase 2 (`FluxDispatcher`) implementadas y probadas contra un `flipper-server`
  0.273.0 real con la app de ejemplo en un emulador Android 14.
- `fixtures/recordings/live-sample-app.jsonl` es una sesión real grabada con `--record`; los tests
  la reproducen contra el server falso.
