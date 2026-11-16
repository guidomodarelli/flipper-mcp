package com.guidomodarelli.fluxflipper

/**
 * How the plugin reads (and optionally replaces) the state of one store.
 * `setState` is used by set_store_state and restore; leave it null for read-only stores.
 */
class FluxStoreBinding<S : Any>(
    val name: String,
    val stateClass: Class<S>,
    val getState: () -> S,
    val setState: ((S) -> Unit)? = null,
)
