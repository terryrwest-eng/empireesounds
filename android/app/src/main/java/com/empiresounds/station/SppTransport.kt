package com.empiresounds.station

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.content.Context
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

/**
 * Classic Bluetooth SPP.
 *
 * This is the one a browser can never do: the XBee-socket Bluetooth module on an
 * ArduSimple pairs at the operating-system level and speaks the serial port
 * profile, which no web API exposes. It is also what most people already have
 * paired for SurPad, so it is the first thing to try.
 */
@SuppressLint("MissingPermission") // callers check BLUETOOTH_CONNECT first
class SppTransport private constructor(
    private val socket: BluetoothSocket,
    private val input: InputStream,
    private val output: OutputStream,
    override val name: String
) : Transport {

    override val kind = "spp"
    @Volatile private var running = true

    override fun write(bytes: ByteArray) {
        output.write(bytes)
        output.flush()
    }

    override fun close() {
        running = false
        try { socket.close() } catch (_: Exception) {}
    }

    private fun startReading() {
        Thread({
            val buf = ByteArray(4096)
            try {
                while (running) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n > 0) Rig.onBytesFromReceiver(buf.copyOf(n))
                }
                if (running) Rig.status("lost", "The receiver closed the link.", name, "spp")
            } catch (e: Exception) {
                if (running) Rig.status("lost", e.message ?: "Bluetooth read failed", name, "spp")
            } finally {
                if (Rig.transport === this) Rig.transport = null
                close()
            }
        }, "spp-read").start()
    }

    companion object {
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

        private fun adapter(context: Context): BluetoothAdapter? {
            val bm = context.getSystemService(Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
            return bm?.adapter
        }

        /** Paired devices only — SPP has to be paired in Android settings first. */
        fun list(context: Context): List<JSONObject> {
            val a = adapter(context) ?: return emptyList()
            if (!a.isEnabled) return emptyList()
            return try {
                a.bondedDevices.map { d ->
                    JSONObject()
                        .put("id", d.address)
                        .put("name", d.name ?: d.address)
                        .put("detail", "paired · ${d.address}")
                }
            } catch (_: SecurityException) {
                emptyList()
            }
        }

        fun connect(context: Context, deviceId: String?) {
            val a = adapter(context)
            if (a == null || !a.isEnabled) {
                Rig.status("error", "Bluetooth is off.", "", "spp")
                return
            }
            val bonded = try { a.bondedDevices } catch (_: SecurityException) {
                Rig.status("error", "Bluetooth permission was refused.", "", "spp"); return
            }
            if (bonded.isEmpty()) {
                Rig.status("error", "No paired Bluetooth devices. Pair the receiver in Android settings first.", "", "spp")
                return
            }
            val device = (if (deviceId == null) bonded.first() else bonded.firstOrNull { it.address == deviceId })
            if (device == null) {
                Rig.status("error", "That device is no longer paired.", "", "spp")
                return
            }
            val label = try { device.name ?: device.address } catch (_: SecurityException) { device.address }
            Rig.status("connecting", label, label, "spp")

            // Connecting blocks for seconds; never on the caller's thread.
            Thread({
                a.cancelDiscovery()
                var socket: BluetoothSocket? = null
                try {
                    socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
                    socket.connect()
                } catch (first: Exception) {
                    try { socket?.close() } catch (_: Exception) {}
                    // Plenty of serial modules advertise no SPP record. Falling
                    // back to channel 1 is the long-standing way in.
                    socket = fallbackSocket(device)
                    if (socket == null) {
                        Rig.status("error", first.message ?: "Could not open the Bluetooth link.", label, "spp")
                        return@Thread
                    }
                    try {
                        socket.connect()
                    } catch (second: Exception) {
                        try { socket.close() } catch (_: Exception) {}
                        Rig.status("error", second.message ?: "The receiver refused the connection.", label, "spp")
                        return@Thread
                    }
                }
                try {
                    val transport = SppTransport(socket, socket.inputStream, socket.outputStream, label)
                    Rig.transport?.close()
                    Rig.transport = transport
                    transport.startReading()
                    Rig.status("connected", "$label · Bluetooth SPP", label, "spp")
                } catch (e: Exception) {
                    try { socket.close() } catch (_: Exception) {}
                    Rig.status("error", e.message ?: "The Bluetooth link opened but would not carry data.", label, "spp")
                }
            }, "spp-connect").start()
        }

        private fun fallbackSocket(device: BluetoothDevice): BluetoothSocket? = try {
            val method = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
            method.invoke(device, 1) as BluetoothSocket
        } catch (_: Exception) {
            null
        }
    }
}
