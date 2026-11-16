package com.example.fluxsample

import okhttp3.OkHttpClient

/** Release builds ship without Flipper. */
object DebugTools {
    const val TRACE_HEADER = "X-Flux-Trace-Id"

    fun install(app: SampleApp, http: OkHttpClient.Builder): OkHttpClient.Builder = http

    fun lastTraceId(): String? = null

    fun <T> withTrace(traceId: String?, block: () -> T): T = block()
}
