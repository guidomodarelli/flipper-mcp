package com.guidomodarelli.fluxflipper

import java.util.UUID

/**
 * Trace id of the action being dispatched on the current thread. Add it to
 * outgoing HTTP requests as [HEADER] so the MCP can correlate
 * Action -> HTTP request -> store change. Capture it with [current] before
 * going async, and restore it around the result dispatch with [runWith].
 */
object FluxTrace {
    const val HEADER = "X-Flux-Trace-Id"

    private val active = ThreadLocal<String?>()

    fun current(): String? = active.get()

    fun newId(): String = UUID.randomUUID().toString().substring(0, 12)

    fun <T> runWith(traceId: String?, block: () -> T): T {
        val previous = active.get()
        active.set(traceId)
        try {
            return block()
        } finally {
            active.set(previous)
        }
    }
}
