package com.empiresounds.station

import android.content.Context
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * The surface the page calls. Every method returns straight away — anything that
 * touches hardware or the network happens on its own thread and reports back as
 * an event, because this runs on the WebView's JavaScript thread and blocking it
 * would freeze the readout.
 *
 * The matching JavaScript side is station/js/native.js.
 */
class StationBridge(private val context: Context, private val onNeedService: (Boolean) -> Unit) {

    @JavascriptInterface
    fun appInfo(): String = okJson {
        put("version", BuildConfig.VERSION_NAME)
        put("android", android.os.Build.VERSION.SDK_INT)
        put("model", android.os.Build.MODEL)
        put("native", true)
    }

    @JavascriptInterface
    fun listTransports(): String = okJson {
        val list = org.json.JSONArray()
        list.put("usb")
        list.put("spp")
        list.put("ble")
        put("transports", list)
    }

    @JavascriptInterface
    fun listDevices(kind: String): String {
        return try {
            val devices = when (kind) {
                "usb" -> UsbSerialTransport.list(context)
                "spp" -> SppTransport.list(context)
                "ble" -> { BleTransport.scan(context); BleTransport.known() }
                else -> emptyList()
            }
            okJson { put("devices", jsonArrayOf(devices)) }
        } catch (e: Exception) {
            errJson(e.message ?: "Could not list devices.")
        }
    }

    @JavascriptInterface
    fun connect(json: String): String {
        return try {
            val o = JSONObject(json)
            val kind = o.optString("kind")
            val id = if (o.isNull("id") || o.optString("id").isEmpty()) null else o.optString("id")
            val baud = o.optInt("baudRate", 38400)
            onNeedService(true)
            when (kind) {
                "usb" -> UsbSerialTransport.connect(context, id, baud)
                "spp" -> SppTransport.connect(context, id)
                "ble" -> BleTransport.connect(context, id)
                else -> return errJson("Unknown connection type: $kind")
            }
            okJson { put("pending", true) }
        } catch (e: Exception) {
            errJson(e.message ?: "Could not start that connection.")
        }
    }

    @JavascriptInterface
    fun write(base64: String): String {
        val t = Rig.transport ?: return errJson("Nothing is connected.")
        return try {
            t.write(Base64Util.decode(base64))
            okJson()
        } catch (e: Exception) {
            errJson(e.message ?: "Write failed.")
        }
    }

    @JavascriptInterface
    fun disconnect(): String {
        Rig.closeAll()
        onNeedService(false)
        Rig.status("off", "", "", "")
        return okJson()
    }

    @JavascriptInterface
    fun sourcetable(json: String): String {
        return try {
            val o = JSONObject(json)
            val requestId = o.optString("requestId", "st")
            Thread({
                try {
                    val text = NtripClient.fetchSourcetable(
                        o.optString("host"), o.optInt("port", 2101), o.optBoolean("tls", false),
                        o.optString("user"), o.optString("pass")
                    )
                    Rig.emit("sourcetable") {
                        put("requestId", requestId)
                        put("ok", true)
                        put("text", text)
                    }
                } catch (e: Exception) {
                    Rig.emit("sourcetable") {
                        put("requestId", requestId)
                        put("ok", false)
                        put("error", e.message ?: "The caster did not answer.")
                    }
                }
            }, "sourcetable").start()
            okJson { put("pending", true) }
        } catch (e: Exception) {
            errJson(e.message ?: "Bad request.")
        }
    }

    @JavascriptInterface
    fun ntripConnect(json: String): String {
        return try {
            val o = JSONObject(json)
            Rig.ntrip?.stop()
            val client = NtripClient(
                host = o.optString("host"),
                port = o.optInt("port", 2101),
                mount = o.optString("mount"),
                user = o.optString("user"),
                pass = o.optString("pass"),
                useTls = o.optBoolean("tls", false),
                ggaIntervalMs = o.optLong("ggaIntervalMs", 10000L),
                ggaProvider = { Rig.lastGga },
                onRtcm = { bytes ->
                    // Straight out to the receiver. The page never sees these.
                    try { Rig.transport?.write(bytes) } catch (_: Exception) {}
                },
                onStatus = { state, detail, retryInMs ->
                    Rig.emit("ntrip") {
                        put("state", state)
                        put("detail", detail)
                        put("mount", o.optString("mount"))
                        put("inMs", retryInMs)
                    }
                },
                onStats = { bytes, types ->
                    Rig.emit("ntripStats") {
                        put("bytes", bytes)
                        put("lastDataAt", System.currentTimeMillis())
                        val arr = org.json.JSONArray()
                        for ((type, count) in types) {
                            arr.put(org.json.JSONArray().put(type).put(count))
                        }
                        put("types", arr)
                    }
                }
            )
            Rig.ntrip = client
            onNeedService(true)
            client.start()
            okJson { put("pending", true) }
        } catch (e: Exception) {
            errJson(e.message ?: "Could not start the correction stream.")
        }
    }

    @JavascriptInterface
    fun ntripDisconnect(): String {
        Rig.ntrip?.stop()
        Rig.ntrip = null
        return okJson()
    }
}
