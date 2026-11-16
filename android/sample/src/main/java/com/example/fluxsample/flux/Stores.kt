package com.example.fluxsample.flux

data class CounterState(val count: Int = 0)

class CounterStore : Store<CounterState>("CounterStore", CounterState()) {
    override fun reduce(state: CounterState, action: Action) = when (action.type) {
        ActionTypes.INCREMENT -> state.copy(count = state.count + ((action.payload["by"] as? Number)?.toInt() ?: 1))
        else -> state
    }
}

data class SessionState(
    val status: String = "idle",
    val user: String? = null,
    val email: String? = null,
    val error: String? = null,
)

class SessionStore : Store<SessionState>("SessionStore", SessionState()) {
    override fun reduce(state: SessionState, action: Action) = when (action.type) {
        ActionTypes.LOGIN_REQUESTED -> state.copy(status = "loading", error = null)
        ActionTypes.LOGIN_SUCCEEDED -> state.copy(
            status = "logged_in",
            user = action.payload["name"] as? String,
            email = action.payload["email"] as? String,
        )
        ActionTypes.LOGIN_FAILED -> state.copy(status = "error", error = action.payload["error"] as? String)
        ActionTypes.LOGOUT -> SessionState()
        else -> state
    }
}

object ActionTypes {
    const val INCREMENT = "INCREMENT"
    const val LOGIN_REQUESTED = "LOGIN_REQUESTED"
    const val LOGIN_SUCCEEDED = "LOGIN_SUCCEEDED"
    const val LOGIN_FAILED = "LOGIN_FAILED"
    const val LOGOUT = "LOGOUT"
}
