package com.example.fluxsample

import android.app.Application
import com.example.fluxsample.flux.CounterStore
import com.example.fluxsample.flux.Dispatcher
import com.example.fluxsample.flux.SessionStore
import okhttp3.OkHttpClient

class SampleApp : Application() {
    val dispatcher = Dispatcher()
    val counterStore = CounterStore()
    val sessionStore = SessionStore()
    lateinit var http: OkHttpClient
        private set
    lateinit var actions: ActionCreators
        private set

    override fun onCreate() {
        super.onCreate()
        dispatcher.register(counterStore)
        dispatcher.register(sessionStore)
        // Debug: Flipper + FluxDispatcher plugin. Release: no-op (see src/release).
        http = DebugTools.install(this, OkHttpClient.Builder()).build()
        actions = ActionCreators(this)
        LocalData.seed(this)
    }
}
