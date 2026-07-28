package com.empiresounds.station

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * The one place that knows what is connected.
 *
 * The web layer owns all the surveying — stationing, offsets, the plan view.
 * This side owns the hardware: a serial link to the receiver, a socket to the
 * caster, and the plumbing between them. Corrections never travel through
 * JavaScript; they go from the caster straight out to the receiver.
 */
object Rig {

    @Volatile var transport: Transport? = null
    @Volatile var ntrip: NtripClient? = null

    /** The most recent complete GGA the receiver has produced, for VRS casters. */
    @Volatile var lastGga: String? = null
        private set

    /** Set by MainActivity; delivers events into the page. */
    @Volatile var emitter: ((JSONObject) -> Unit)? = null

    private val ggaBuffer = StringBuilder()

    fun emit(obj: JSONObject) {
        emitter?.invoke(obj)
    }

    fun emit(type: String, build: JSONObject.() -> Unit = {}) {
        val o = JSONObject()
        o.put("type", type)
        o.build()
        emit(o)
    }

    val connected: Boolean
        get() = transport != null

    fun onBytesFromReceiver(bytes: ByteArray) {
        scanForGga(bytes)
        emit("data") { put("b64", Base64Util.encode(bytes)) }
    }

    fun status(state: String, detail: String, name: String, kind: String) {
        emit("status") {
            put("state", state)
            put("detail", detail)
            put("name", name)
            put("kind", kind)
        }
    }

    /**
     * Pull the last complete GGA out of the NMEA stream. Only sentences with a
     * good checksum count — sending a corrupt position to a VRS caster would
     * put the virtual base in the wrong place.
     */
    private fun scanForGga(bytes: ByteArray) {
        for (b in bytes) {
            val c = (b.toInt() and 0xff).toChar()
            if (c == '$') {
                ggaBuffer.setLength(0)
                ggaBuffer.append(c)
            } else if (ggaBuffer.isNotEmpty()) {
                if (c == '\r' || c == '\n') {
                    val line = ggaBuffer.toString()
                    ggaBuffer.setLength(0)
                    if (line.length > 20 && line.substring(0, 7).contains("GGA") && checksumOk(line)) {
                        lastGga = line
                    }
                } else {
                    ggaBuffer.append(c)
                    if (ggaBuffer.length > 200) ggaBuffer.setLength(0)
                }
            }
        }
    }

    private fun checksumOk(line: String): Boolean {
        val star = line.lastIndexOf('*')
        if (star < 1 || star + 3 > line.length) return false
        var sum = 0
        for (i in 1 until star) sum = sum xor line[i].code
        val given = line.substring(star + 1, star + 3).toIntOrNull(16) ?: return false
        return sum == given
    }

    fun closeAll() {
        ntrip?.stop()
        ntrip = null
        transport?.close()
        transport = null
        lastGga = null
    }
}

/** Anything that can carry bytes to and from a receiver. */
interface Transport {
    val kind: String
    val name: String
    fun write(bytes: ByteArray)
    fun close()
}

object Base64Util {
    fun encode(bytes: ByteArray): String = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
    fun decode(text: String): ByteArray = android.util.Base64.decode(text, android.util.Base64.NO_WRAP)
}

/** Small helpers so the JSON in this module stays readable. */
fun okJson(build: (JSONObject.() -> Unit)? = null): String {
    val o = JSONObject()
    o.put("ok", true)
    build?.invoke(o)
    return o.toString()
}

fun errJson(message: String): String = JSONObject().put("ok", false).put("error", message).toString()

fun jsonArrayOf(items: List<JSONObject>): JSONArray {
    val a = JSONArray()
    for (i in items) a.put(i)
    return a
}
