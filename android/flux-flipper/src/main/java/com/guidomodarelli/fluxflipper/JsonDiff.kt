package com.guidomodarelli.fluxflipper

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject

/** Minimal JSON-Patch-like diff: {op: add|remove|replace, path, value?, old?}. */
object JsonDiff {
    fun diff(before: JsonElement?, after: JsonElement?, maxOps: Int = 100): JsonArray {
        val ops = JsonArray()
        walk(before ?: JsonNull.INSTANCE, after ?: JsonNull.INSTANCE, "", ops, maxOps)
        return ops
    }

    private fun escape(key: String) = key.replace("~", "~0").replace("/", "~1")

    private fun op(kind: String, path: String, value: JsonElement?, old: JsonElement?): JsonObject =
        JsonObject().apply {
            addProperty("op", kind)
            addProperty("path", path)
            if (value != null) add("value", value)
            if (old != null) add("old", old)
        }

    private fun walk(before: JsonElement, after: JsonElement, path: String, ops: JsonArray, maxOps: Int) {
        if (ops.size() >= maxOps || before == after) return
        if (before is JsonObject && after is JsonObject) {
            for ((key, value) in after.entrySet()) {
                val child = "$path/${escape(key)}"
                if (!before.has(key)) ops.add(op("add", child, value, null))
                else walk(before.get(key), value, child, ops, maxOps)
                if (ops.size() >= maxOps) return
            }
            for ((key, value) in before.entrySet()) {
                if (!after.has(key)) ops.add(op("remove", "$path/${escape(key)}", null, value))
                if (ops.size() >= maxOps) return
            }
            return
        }
        if (before is JsonArray && after is JsonArray && before.size() == after.size()) {
            for (i in 0 until after.size()) {
                walk(before.get(i), after.get(i), "$path/$i", ops, maxOps)
                if (ops.size() >= maxOps) return
            }
            return
        }
        ops.add(op("replace", path, after, before))
    }
}
