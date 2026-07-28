package com.empiresounds.station

import android.util.Base64
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.SSLSocketFactory

/**
 * NTRIP straight to the caster.
 *
 * No relay, no WebSocket, no browser in the path: the phone dials the caster,
 * and RTCM goes from this socket to the receiver's serial port. That is the
 * whole reason the native app exists.
 *
 * Works with any standard caster — a subscription network, a state CORS system,
 * RTK2go — over NTRIP 1 or 2, plain or TLS.
 */
class NtripClient(
    private val host: String,
    private val port: Int,
    private val mount: String,
    private val user: String,
    private val pass: String,
    private val useTls: Boolean,
    private val ggaIntervalMs: Long,
    private val ggaProvider: () -> String?,
    private val onRtcm: (ByteArray) -> Unit,
    private val onStatus: (state: String, detail: String, retryInMs: Long) -> Unit,
    private val onStats: (bytes: Long, types: Map<Int, Int>) -> Unit
) {
    @Volatile private var running = false
    private var thread: Thread? = null
    private var totalBytes = 0L
    private val types = LinkedHashMap<Int, Int>()
    private val framer = RtcmFramer { type -> types[type] = (types[type] ?: 0) + 1 }

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "ntrip").also { it.start() }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
        onStatus("off", "", 0)
    }

    private fun loop() {
        var attempt = 0
        while (running) {
            var socket: Socket? = null
            try {
                onStatus("connecting", mount, 0)
                socket = openSocket()
                val out = socket.getOutputStream()
                val input = socket.getInputStream()
                out.write(requestHead().toByteArray(Charsets.ISO_8859_1))
                ggaProvider()?.let { out.write(("$it\r\n").toByteArray(Charsets.ISO_8859_1)) }
                out.flush()

                val leftover = readHandshake(input)
                attempt = 0
                onStatus("on", mount, 0)
                startGgaPump(out)
                if (leftover.isNotEmpty()) consume(leftover)
                pump(input)
            } catch (e: Exception) {
                if (!running) break
                val wait = minOf(30000L, 2000L * (1L shl minOf(attempt, 4)))
                attempt++
                onStatus("retrying", e.message ?: "The caster dropped the connection.", wait)
                try { Thread.sleep(wait) } catch (_: InterruptedException) { break }
            } finally {
                try { socket?.close() } catch (_: Exception) {}
            }
        }
        onStatus("off", "", 0)
    }

    private fun openSocket(): Socket {
        val plain = Socket()
        plain.connect(InetSocketAddress(host, port), 15000)
        plain.soTimeout = 60000
        plain.tcpNoDelay = true
        if (!useTls) return plain
        val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory)
            .createSocket(plain, host, port, true)
        ssl.soTimeout = 60000
        return ssl
    }

    private fun authHeader(): String? {
        if (user.isEmpty() && pass.isEmpty()) return null
        val raw = "$user:$pass".toByteArray(Charsets.ISO_8859_1)
        return Base64.encodeToString(raw, Base64.NO_WRAP)
    }

    private fun requestHead(): String {
        val sb = StringBuilder()
        sb.append("GET /").append(mount).append(" HTTP/1.1\r\n")
        sb.append("Host: ").append(host).append(":").append(port).append("\r\n")
        sb.append("Ntrip-Version: Ntrip/2.0\r\n")
        sb.append("User-Agent: NTRIP StationAndroid/1.0\r\n")
        authHeader()?.let { sb.append("Authorization: Basic ").append(it).append("\r\n") }
        sb.append("Connection: close\r\n\r\n")
        return sb.toString()
    }

    /**
     * Casters answer either HTTP/1.1 (NTRIP 2) or the shoutcast-style
     * "ICY 200 OK" (NTRIP 1), and the ICY form may end its header with one CRLF
     * rather than two. Returns whatever body arrived in the same read.
     */
    private fun readHandshake(input: InputStream): ByteArray {
        val head = StringBuilder()
        val buf = ByteArray(1)
        val body = ArrayList<Byte>()
        var isIcy = false
        while (running) {
            val n = input.read(buf)
            if (n < 0) throw java.io.IOException("The caster closed the connection during the handshake.")
            val c = buf[0].toInt().toChar()
            head.append(c)
            if (head.length == 3) isIcy = head.startsWith("ICY")
            if (isIcy) {
                if (head.endsWith("\r\n")) {
                    // Peek: a second CRLF means a full header block.
                    if (input.available() >= 2) {
                        val two = ByteArray(2)
                        val got = input.read(two, 0, 2)
                        if (got == 2 && two[0].toInt().toChar() == '\r' && two[1].toInt().toChar() == '\n') {
                            // header ended
                        } else {
                            for (i in 0 until got) body.add(two[i])
                        }
                    }
                    break
                }
            } else if (head.endsWith("\r\n\r\n")) {
                break
            }
            if (head.length > 8192) throw java.io.IOException("The caster sent an unreadable response.")
        }
        val status = head.toString().lineSequence().firstOrNull() ?: ""
        when {
            status.contains("401") -> throw java.io.IOException("The caster rejected that username or password.")
            status.startsWith("SOURCETABLE") -> throw java.io.IOException("The caster does not have mountpoint $mount.")
            status.contains("200") -> Unit
            else -> throw java.io.IOException("The caster answered: ${status.take(120)}")
        }
        return body.toByteArray()
    }

    private fun pump(input: InputStream) {
        val buf = ByteArray(4096)
        while (running) {
            val n = input.read(buf)
            if (n < 0) throw java.io.IOException("The caster closed the connection.")
            if (n > 0) consume(buf.copyOf(n))
        }
    }

    private fun consume(chunk: ByteArray) {
        totalBytes += chunk.size
        framer.push(chunk)
        onRtcm(chunk)
        onStats(totalBytes, types)
    }

    /** VRS mountpoints place a virtual base at the rover, so keep telling it. */
    private fun startGgaPump(out: OutputStream) {
        Thread({
            while (running) {
                try { Thread.sleep(ggaIntervalMs) } catch (_: InterruptedException) { return@Thread }
                if (!running) return@Thread
                val gga = ggaProvider() ?: continue
                try {
                    out.write(("$gga\r\n").toByteArray(Charsets.ISO_8859_1))
                    out.flush()
                } catch (_: Exception) {
                    return@Thread // the read side will notice and reconnect
                }
            }
        }, "ntrip-gga").start()
    }

    companion object {
        /** Blocking; call it off the caller's thread. */
        fun fetchSourcetable(host: String, port: Int, useTls: Boolean, user: String, pass: String): String {
            val socket = Socket()
            socket.connect(InetSocketAddress(host, port), 15000)
            socket.soTimeout = 15000
            val s = if (useTls) {
                (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(socket, host, port, true)
            } else socket
            try {
                val sb = StringBuilder()
                sb.append("GET / HTTP/1.1\r\n")
                sb.append("Host: ").append(host).append(":").append(port).append("\r\n")
                sb.append("Ntrip-Version: Ntrip/2.0\r\n")
                sb.append("User-Agent: NTRIP StationAndroid/1.0\r\n")
                if (user.isNotEmpty() || pass.isNotEmpty()) {
                    val raw = "$user:$pass".toByteArray(Charsets.ISO_8859_1)
                    sb.append("Authorization: Basic ").append(Base64.encodeToString(raw, Base64.NO_WRAP)).append("\r\n")
                }
                sb.append("Connection: close\r\n\r\n")
                s.getOutputStream().write(sb.toString().toByteArray(Charsets.ISO_8859_1))
                s.getOutputStream().flush()

                val input = s.getInputStream()
                val out = StringBuilder()
                val buf = ByteArray(4096)
                while (out.length < 2_000_000) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.append(String(buf, 0, n, Charsets.ISO_8859_1))
                    if (out.contains("ENDSOURCETABLE")) break
                }
                val text = out.toString()
                val cut = text.indexOf("\r\n\r\n")
                return if (cut >= 0) text.substring(cut + 4) else text
            } finally {
                try { s.close() } catch (_: Exception) {}
                try { socket.close() } catch (_: Exception) {}
            }
        }
    }
}

/** Just enough RTCM 3 to count message types, for the diagnostics panel. */
class RtcmFramer(private val onMessage: (Int) -> Unit) {
    private var buf = ByteArray(0)

    fun push(chunk: ByteArray) {
        buf = buf + chunk
        var i = 0
        while (i + 6 <= buf.size) {
            if ((buf[i].toInt() and 0xff) != 0xD3) { i++; continue }
            val len = ((buf[i + 1].toInt() and 0x03) shl 8) or (buf[i + 2].toInt() and 0xff)
            val total = len + 6
            if (i + total > buf.size) break
            if (len >= 2) {
                val type = ((buf[i + 3].toInt() and 0xff) shl 4) or ((buf[i + 4].toInt() and 0xff) shr 4)
                onMessage(type)
            }
            i += total
        }
        buf = if (i >= buf.size) ByteArray(0) else buf.copyOfRange(i, buf.size)
        if (buf.size > 8192) buf = buf.copyOfRange(buf.size - 1024, buf.size)
    }
}
