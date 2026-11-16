package com.example.fluxsample

import android.util.Log
import com.example.fluxsample.flux.Action
import com.example.fluxsample.flux.ActionTypes
import com.google.gson.JsonParser
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import java.io.IOException

/** Async work lives here; results come back as actions with the same trace id. */
class ActionCreators(private val app: SampleApp) {
    fun increment() = app.dispatcher.dispatch(Action(ActionTypes.INCREMENT, mapOf("by" to 1)))

    fun login(userId: Int = 1) = request(
        "https://jsonplaceholder.typicode.com/users/$userId",
        start = Action(ActionTypes.LOGIN_REQUESTED, mapOf("userId" to userId)),
    ) { body ->
        val user = JsonParser.parseString(body).asJsonObject
        LocalData.saveSession(app, user.get("name").asString)
        Action(ActionTypes.LOGIN_SUCCEEDED, mapOf("name" to user.get("name").asString, "email" to user.get("email").asString))
    }

    fun failingRequest() = request(
        "https://httpbin.org/status/500",
        start = Action(ActionTypes.LOGIN_REQUESTED, mapOf("userId" to -1)),
    ) { error("unreachable") }

    private fun request(url: String, start: Action, onSuccess: (String) -> Action) {
        app.dispatcher.dispatch(start)
        val traceId = DebugTools.lastTraceId()
        val builder = Request.Builder().url(url)
        traceId?.let { builder.header(DebugTools.TRACE_HEADER, it) }
        Log.i(TAG, "GET $url traceId=$traceId")
        app.http.newCall(builder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = finish(traceId, Action(ActionTypes.LOGIN_FAILED, mapOf("error" to e.toString())))

            override fun onResponse(call: Call, response: Response) {
                val body = response.use { it.body?.string().orEmpty() }
                val action = if (response.isSuccessful) onSuccess(body)
                else Action(ActionTypes.LOGIN_FAILED, mapOf("error" to "HTTP ${response.code}"))
                if (!response.isSuccessful) Log.e(TAG, "login failed: HTTP ${response.code} traceId=$traceId")
                else Log.i(TAG, "login done traceId=$traceId")
                finish(traceId, action)
            }
        })
    }

    /** Back on the main thread, dispatch the result under the original trace id. */
    private fun finish(traceId: String?, action: Action) {
        main.post { DebugTools.withTrace(traceId) { app.dispatcher.dispatch(action) } }
    }

    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    companion object {
        const val TAG = "FluxSample"
    }
}
