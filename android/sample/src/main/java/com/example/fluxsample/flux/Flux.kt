package com.example.fluxsample.flux

import android.os.Handler
import android.os.Looper

/** A Flux action: a type plus an untyped payload. */
data class Action(val type: String, val payload: Map<String, Any?> = emptyMap())

/** Stores own their state, update it in [reduce] and notify listeners. */
abstract class Store<S : Any>(val name: String, initial: S) {
    @Volatile var state: S = initial
        private set
    private val listeners = mutableListOf<(S) -> Unit>()

    /** Returns the call that removes the listener; views call it when they are destroyed. */
    fun subscribe(listener: (S) -> Unit): () -> Unit {
        listeners += listener
        listener(state)
        return { listeners -= listener }
    }

    /** Used by reduce and by debug tooling (set_store_state / restore). */
    fun replaceState(newState: S) {
        if (newState == state) return
        state = newState
        listeners.forEach { it(newState) }
    }

    abstract fun reduce(state: S, action: Action): S
}

/** Lets debug builds observe every dispatch without the release build knowing about Flipper. */
fun interface DispatchInterceptor {
    fun intercept(action: Action, proceed: () -> Unit)
}

/** Single dispatcher, unidirectional flow, always on the main thread. */
class Dispatcher {
    private val stores = mutableListOf<Store<*>>()
    private val main = Handler(Looper.getMainLooper())
    private var dispatching = false
    var interceptor: DispatchInterceptor? = null

    fun register(store: Store<*>) {
        stores += store
    }

    val registeredStores: List<Store<*>> get() = stores

    fun dispatch(action: Action) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { dispatch(action) }
            return
        }
        check(!dispatching) { "Cannot dispatch ${action.type} in the middle of a dispatch" }
        dispatching = true
        try {
            val run = { stores.forEach { reduceInto(it, action) } }
            interceptor?.intercept(action, run) ?: run()
        } finally {
            dispatching = false
        }
    }

    private fun <S : Any> reduceInto(store: Store<S>, action: Action) {
        store.replaceState(store.reduce(store.state, action))
    }
}
