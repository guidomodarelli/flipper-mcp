package com.example.fluxsample

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView

/** The View layer: renders store state and turns clicks into actions. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val app = application as SampleApp
        val counter = findViewById<TextView>(R.id.counter_text)
        val session = findViewById<TextView>(R.id.session_text)
        val progress = findViewById<ProgressBar>(R.id.progress)

        app.counterStore.subscribe { counter.text = "Count: ${it.count}" }
        app.sessionStore.subscribe {
            progress.visibility = if (it.status == "loading") View.VISIBLE else View.GONE
            session.text = when (it.status) {
                "logged_in" -> "Hola ${it.user}"
                "error" -> "Error: ${it.error}"
                "loading" -> "Loading…"
                else -> "Logged out"
            }
        }
        findViewById<Button>(R.id.increment_button).setOnClickListener { app.actions.increment() }
        findViewById<Button>(R.id.login_button).setOnClickListener { app.actions.login() }
        findViewById<Button>(R.id.fail_button).setOnClickListener { app.actions.failingRequest() }
    }
}
