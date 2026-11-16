package com.example.fluxsample

import com.example.fluxsample.flux.Action
import com.example.fluxsample.flux.CounterState
import com.example.fluxsample.flux.SessionState
import com.facebook.flipper.android.AndroidFlipperClient
import com.facebook.flipper.android.utils.FlipperUtils
import com.facebook.flipper.plugins.databases.DatabasesFlipperPlugin
import com.facebook.flipper.plugins.network.FlipperOkhttpInterceptor
import com.facebook.flipper.plugins.network.NetworkFlipperPlugin
import com.facebook.flipper.plugins.sharedpreferences.SharedPreferencesFlipperPlugin
import com.facebook.flipper.plugins.uidebugger.UIDebuggerFlipperPlugin
import com.facebook.flipper.plugins.uidebugger.core.UIDContext
import com.facebook.soloader.SoLoader
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.guidomodarelli.fluxflipper.FluxDispatcherFlipperPlugin
import com.guidomodarelli.fluxflipper.FluxStoreBinding
import com.guidomodarelli.fluxflipper.FluxTrace
import okhttp3.OkHttpClient

/** Debug-only wiring of Flipper and the FluxDispatcher plugin. */
object DebugTools {
    const val TRACE_HEADER = FluxTrace.HEADER
    @Volatile private var lastTrace: String? = null

    fun install(app: SampleApp, http: OkHttpClient.Builder): OkHttpClient.Builder {
        SoLoader.init(app, false)
        if (!FlipperUtils.shouldEnableFlipper(app)) return http
        val network = NetworkFlipperPlugin()
        val flux = FluxDispatcherFlipperPlugin(
            stores = listOf(
                FluxStoreBinding("CounterStore", CounterState::class.java, { app.counterStore.state }, app.counterStore::replaceState),
                FluxStoreBinding("SessionStore", SessionState::class.java, { app.sessionStore.state }, app.sessionStore::replaceState),
            ),
            dispatchAction = { type, payloadJson ->
                val payload: Map<String, Any?> = payloadJson?.let {
                    Gson().fromJson(it, object : TypeToken<Map<String, Any?>>() {}.type)
                } ?: emptyMap()
                app.dispatcher.dispatch(Action(type, payload))
            },
        )
        app.dispatcher.interceptor = com.example.fluxsample.flux.DispatchInterceptor { action, proceed ->
            flux.trace(action.type, action.payload) {
                lastTrace = FluxTrace.current()
                proceed()
            }
        }
        AndroidFlipperClient.getInstance(app).apply {
            addPlugin(UIDebuggerFlipperPlugin(UIDContext.create(app)))
            addPlugin(network)
            addPlugin(DatabasesFlipperPlugin(app))
            // List the files explicitly: without it the plugin only sees files that exist at startup.
            addPlugin(SharedPreferencesFlipperPlugin(app, listOf(
                SharedPreferencesFlipperPlugin.SharedPreferencesDescriptor("session_prefs", android.content.Context.MODE_PRIVATE),
                SharedPreferencesFlipperPlugin.SharedPreferencesDescriptor("flags", android.content.Context.MODE_PRIVATE),
            )))
            addPlugin(flux)
            start()
        }
        return http.addNetworkInterceptor(FlipperOkhttpInterceptor(network))
    }

    /** Trace id of the last action dispatched (dispatch is synchronous on the main thread). */
    fun lastTraceId(): String? = lastTrace

    fun <T> withTrace(traceId: String?, block: () -> T): T = FluxTrace.runWith(traceId, block)
}
