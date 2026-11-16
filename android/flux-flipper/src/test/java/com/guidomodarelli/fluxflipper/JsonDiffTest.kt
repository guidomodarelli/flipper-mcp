package com.guidomodarelli.fluxflipper

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Test

class JsonDiffTest {
    private fun diff(before: String, after: String) =
        JsonDiff.diff(JsonParser.parseString(before), JsonParser.parseString(after)).toString()

    @Test
    fun reportsReplacedAddedAndRemovedFields() {
        assertEquals(
            """[{"op":"replace","path":"/status","value":"loading","old":"idle"},{"op":"add","path":"/user","value":"ana"},{"op":"remove","path":"/error","old":"x"}]""",
            diff("""{"status":"idle","error":"x"}""", """{"status":"loading","user":"ana"}"""),
        )
    }

    @Test
    fun recursesIntoSameSizeArraysAndEscapesKeys() {
        assertEquals(
            """[{"op":"replace","path":"/a~1b/1","value":3,"old":2}]""",
            diff("""{"a/b":[1,2]}""", """{"a/b":[1,3]}"""),
        )
    }

    @Test
    fun replacesArraysThatChangeSize() {
        assertEquals("""[{"op":"replace","path":"/items","value":[1],"old":[]}]""", diff("""{"items":[]}""", """{"items":[1]}"""))
    }

    @Test
    fun returnsNoOpsForEqualStates() {
        assertEquals("[]", diff("""{"a":{"b":1}}""", """{"a":{"b":1}}"""))
    }

    @Test
    fun capsTheNumberOfOps() {
        val before = (0 until 10).joinToString(",", "{", "}") { "\"k$it\":0" }
        val after = (0 until 10).joinToString(",", "{", "}") { "\"k$it\":1" }
        assertEquals(3, JsonDiff.diff(JsonParser.parseString(before), JsonParser.parseString(after), maxOps = 3).size())
    }

    @Test
    fun keepsTheTraceIdOnlyInsideRunWith() {
        assertEquals(null, FluxTrace.current())
        assertEquals("t1", FluxTrace.runWith("t1") { FluxTrace.current() })
        assertEquals(null, FluxTrace.current())
    }
}
