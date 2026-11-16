package com.guidomodarelli.fluxflipper

import android.os.SystemClock
import com.facebook.flipper.core.FlipperConnection
import com.facebook.flipper.core.FlipperObject
import com.facebook.flipper.core.FlipperPlugin
import com.facebook.flipper.core.FlipperResponder
import com.facebook.flipper.plugins.common.MainThreadFlipperReceiver
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.util.concurrent.atomic.AtomicLong

/**
 * Flipper plugin "FluxDispatcher" (debug builds only).
 *
 * Hook it into your Dispatcher: wrap every dispatch with [trace]. It sends one
 * `action` message per dispatched action with the store diffs, and answers
 * getStores / getStoreState / setStoreState / dispatchAction / snapshot / restore.
 * Wire format: PROTOCOL.md §4 of flipper-mcp.
 *
 * @param dispatchAction builds and dispatches an action from its type and JSON
 *   payload; null disables dispatchAction.
 */
class FluxDispatcherFlipperPlugin(
    stores: List<FluxStoreBinding<*>>,
    private val dispatchAction: ((type: String, payloadJson: String?) -> Unit)? = null,
    private val gson: Gson = Gson(),
    private val maxSnapshots: Int = 20,
) : FlipperPlugin {
    private val stores = stores.associateBy { it.name }
    private val sequence = AtomicLong()
    private val snapshots = LinkedHashMap<String, Map<String, JsonElement>>()

    @Volatile private var connection: FlipperConnection? = null

    override fun getId(): String = ID

    /** Background: keeps sending actions while the web UI shows another plugin. */
    override fun runInBackground(): Boolean = true

    override fun onConnect(connection: FlipperConnection) {
        this.connection = connection
        connection.receive("getStores", receiver { _, responder ->
            val names = JsonArray().apply { stores.keys.forEach { add(it) } }
            responder.success(obj(JsonObject().apply { add("stores", names) }))
        })
        connection.receive("getStoreState", receiver { params, responder ->
            val store = requireStore(params.getString("store"))
            responder.success(obj(JsonObject().apply {
                addProperty("store", store.name)
                add("state", serialize(store))
            }))
        })
        connection.receive("setStoreState", receiver { params, responder ->
            val store = requireStore(params.getString("store"))
            val state = params.get("state") ?: throw IllegalArgumentException("Missing 'state'")
            apply(store, JsonParser.parseString(stateJson(state)))
            responder.success(obj(JsonObject().apply { addProperty("ok", true) }))
        })
        connection.receive("dispatchAction", receiver { params, responder ->
            val dispatch = dispatchAction
                ?: throw UnsupportedOperationException("dispatchAction is not enabled for this app")
            val type = params.getString("type") ?: throw IllegalArgumentException("Missing 'type'")
            val payload = params.get("payload")?.let { stateJson(it) }
            val traceId = FluxTrace.newId()
            FluxTrace.runWith(traceId) { dispatch(type, payload) }
            responder.success(obj(JsonObject().apply { addProperty("traceId", traceId) }))
        })
        connection.receive("snapshot", receiver { params, responder ->
            // getArray never returns null (a missing key gives an empty array), so check the key.
            val names = if (params.contains("stores")) {
                val array = params.getArray("stores")
                (0 until array.length()).map { array.getString(it) }
            } else {
                stores.keys.toList()
            }
            val captured = names.associateWith { serialize(requireStore(it)) }
            val id = "snap-${sequence.incrementAndGet()}"
            synchronized(snapshots) {
                snapshots[id] = captured
                while (snapshots.size > maxSnapshots) snapshots.remove(snapshots.keys.first())
            }
            responder.success(obj(JsonObject().apply {
                addProperty("snapshotId", id)
                add("stores", JsonArray().apply { names.forEach { add(it) } })
            }))
        })
        connection.receive("restore", receiver { params, responder ->
            val id = params.getString("snapshotId")
            val snapshot = synchronized(snapshots) { snapshots[id] }
                ?: throw IllegalArgumentException("Unknown snapshot '$id'. Snapshots are lost when the app restarts.")
            val restored = JsonArray()
            for ((name, state) in snapshot) {
                apply(requireStore(name), state)
                restored.add(name)
            }
            responder.success(obj(JsonObject().apply { add("restored", restored) }))
        })
    }

    override fun onDisconnect() {
        connection = null
    }

    /**
     * Runs [dispatch] and reports the action. Call it from your Dispatcher for
     * every action; it is cheap when Flipper is not connected.
     */
    fun <T> trace(type: String, payload: Any?, dispatch: () -> T): T {
        val conn = connection ?: return FluxTrace.runWith(FluxTrace.current() ?: FluxTrace.newId(), dispatch)
        val traceId = FluxTrace.current() ?: FluxTrace.newId()
        val before = stores.values.associate { it.name to safeSerialize(it) }
        val started = SystemClock.elapsedRealtime()
        var error: Throwable? = null
        val result = try {
            FluxTrace.runWith(traceId, dispatch)
        } catch (t: Throwable) {
            error = t
            throw t
        } finally {
            val message = JsonObject().apply {
                addProperty("seq", sequence.incrementAndGet())
                addProperty("type", type)
                if (payload != null) add("payload", safeTree(payload))
                addProperty("traceId", traceId)
                addProperty("ts", System.currentTimeMillis())
                addProperty("durationMs", SystemClock.elapsedRealtime() - started)
                val changes = JsonArray()
                for (store in stores.values) {
                    val diff = JsonDiff.diff(before[store.name], safeSerialize(store))
                    if (diff.size() > 0) changes.add(JsonObject().apply {
                        addProperty("store", store.name)
                        add("diff", diff)
                    })
                }
                add("changes", changes)
                error?.let { addProperty("error", "${it.javaClass.simpleName}: ${it.message}") }
            }
            conn.send("action", obj(message))
        }
        return result
    }

    private fun requireStore(name: String?): FluxStoreBinding<*> =
        stores[name] ?: throw IllegalArgumentException("Unknown store '$name'. Stores: ${stores.keys}")

    private fun serialize(store: FluxStoreBinding<*>): JsonElement = gson.toJsonTree(store.getState())

    private fun safeSerialize(store: FluxStoreBinding<*>): JsonElement? =
        try { serialize(store) } catch (t: Throwable) { null }

    private fun safeTree(value: Any): JsonElement =
        try { gson.toJsonTree(value) } catch (t: Throwable) { com.google.gson.JsonPrimitive(value.toString()) }

    private fun <S : Any> applyTyped(store: FluxStoreBinding<S>, state: JsonElement) {
        val setter = store.setState
            ?: throw UnsupportedOperationException("Store '${store.name}' is read-only (no setState binding)")
        setter(gson.fromJson(state, store.stateClass))
    }

    private fun apply(store: FluxStoreBinding<*>, state: JsonElement) = applyTyped(store, state)

    /** FlipperObject.get returns FlipperObject/FlipperArray/primitives; turn any into JSON text. */
    private fun stateJson(value: Any): String = when (value) {
        is FlipperObject -> value.toJsonString()
        is com.facebook.flipper.core.FlipperArray -> value.toJsonString()
        is String -> gson.toJson(value)
        else -> value.toString()
    }

    private fun obj(json: JsonObject) = FlipperObject(json.toString())

    private fun receiver(handler: (FlipperObject, FlipperResponder) -> Unit) =
        object : MainThreadFlipperReceiver() {
            override fun onReceiveOnMainThread(params: FlipperObject, responder: FlipperResponder) =
                handler(params, responder)
        }

    companion object {
        const val ID = "FluxDispatcher"
    }
}
