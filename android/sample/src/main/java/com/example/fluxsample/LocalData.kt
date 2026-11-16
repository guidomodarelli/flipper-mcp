package com.example.fluxsample

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** SQLite + SharedPreferences so the Databases and Preferences plugins have data. */
object LocalData {
    private class Helper(context: Context) : SQLiteOpenHelper(context, "app.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT)")
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }

    fun seed(context: Context) {
        val db = Helper(context).writableDatabase
        if (db.compileStatement("SELECT COUNT(*) FROM users").simpleQueryForLong() == 0L) {
            listOf("ana" to "admin", "beto" to "user", "caro" to "user").forEachIndexed { i, (name, role) ->
                db.insert("users", null, ContentValues().apply {
                    put("id", i + 1)
                    put("name", name)
                    put("role", role)
                })
            }
        }
        context.getSharedPreferences("flags", Context.MODE_PRIVATE).edit().putBoolean("dark_mode", false).apply()
    }

    fun saveSession(context: Context, user: String) {
        context.getSharedPreferences("session_prefs", Context.MODE_PRIVATE).edit()
            .putString("user", user)
            .putLong("logged_in_at", System.currentTimeMillis())
            .apply()
    }
}
