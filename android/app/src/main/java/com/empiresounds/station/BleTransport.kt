package com.empiresounds.station

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Serial over BLE — the profile used by u-blox's own Bluetooth boards and by the
 * cheap HM-10 style modules. Slower than SPP or USB, and MTU-limited, which
 * matters when RTCM is going the other way, so it chunks its writes.
 */
@SuppressLint("MissingPermission")
class BleTransport private constructor(
    private val gatt: BluetoothGatt,
    private val writeChar: BluetoothGattCharacteristic?,
    override val name: String
) : Transport {

    override val kind = "ble"
    @Volatile private var mtuPayload = 20

    override fun write(bytes: ByteArray) {
        val c = writeChar ?: return
        var i = 0
        while (i < bytes.size) {
            val end = minOf(i + mtuPayload, bytes.size)
            val slice = bytes.copyOfRange(i, end)
            c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            @Suppress("DEPRECATION")
            c.value = slice
            @Suppress("DEPRECATION")
            gatt.writeCharacteristic(c)
            // BLE writes queue one at a time; a short pause keeps a burst of
            // RTCM from being dropped on the floor.
            try { Thread.sleep(6) } catch (_: InterruptedException) {}
            i = end
        }
    }

    override fun close() {
        try { gatt.disconnect() } catch (_: Exception) {}
        try { gatt.close() } catch (_: Exception) {}
    }

    private fun setMtu(payload: Int) { mtuPayload = payload }

    companion object {
        private const val CCCD = "00002902-0000-1000-8000-00805F9B34FB"

        private data class Profile(val label: String, val service: UUID, val write: UUID, val notify: UUID)

        private val PROFILES = listOf(
            Profile("Nordic UART",
                UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e"),
                UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e"),
                UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")),
            Profile("u-blox SPS",
                UUID.fromString("2456e1b9-26e2-8f83-e744-f34f01e9d701"),
                UUID.fromString("2456e1b9-26e2-8f83-e744-f34f01e9d703"),
                UUID.fromString("2456e1b9-26e2-8f83-e744-f34f01e9d702")),
            Profile("HM-10",
                UUID.fromString("0000ffe0-0000-1000-8000-00805f9b34fb"),
                UUID.fromString("0000ffe1-0000-1000-8000-00805f9b34fb"),
                UUID.fromString("0000ffe1-0000-1000-8000-00805f9b34fb"))
        )

        private val found = ConcurrentHashMap<String, String>()
        private var scanning = false

        fun known(): List<JSONObject> = found.map { (addr, name) ->
            JSONObject().put("id", addr).put("name", name).put("detail", "BLE · $addr")
        }

        /** A short scan; results arrive as events so the page can fill in live. */
        fun scan(context: Context) {
            val bm = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager ?: return
            val scanner = bm.adapter?.bluetoothLeScanner ?: return
            if (scanning) return
            scanning = true
            found.clear()
            val callback = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    val device = result.device ?: return
                    val label = try { device.name } catch (_: SecurityException) { null } ?: return
                    if (found.put(device.address, label) == null) {
                        Rig.emit("devices") {
                            put("kind", "ble")
                            put("devices", jsonArrayOf(known()))
                        }
                    }
                }
                override fun onScanFailed(errorCode: Int) {
                    scanning = false
                    Rig.status("error", "Bluetooth scan failed ($errorCode).", "", "ble")
                }
            }
            val settings = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()
            try {
                scanner.startScan(null, settings, callback)
            } catch (e: SecurityException) {
                scanning = false
                Rig.status("error", "Bluetooth scan permission was refused.", "", "ble")
                return
            }
            Handler(Looper.getMainLooper()).postDelayed({
                try { scanner.stopScan(callback) } catch (_: Exception) {}
                scanning = false
                Rig.emit("devices") {
                    put("kind", "ble")
                    put("devices", jsonArrayOf(known()))
                    put("done", true)
                }
            }, 8000)
        }

        fun connect(context: Context, deviceId: String?) {
            val bm = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            val adapter = bm?.adapter
            if (adapter == null || !adapter.isEnabled) {
                Rig.status("error", "Bluetooth is off.", "", "ble")
                return
            }
            val address = deviceId ?: found.keys.firstOrNull()
            if (address == null) {
                Rig.status("error", "Scan for a BLE receiver first.", "", "ble")
                return
            }
            val device = try { adapter.getRemoteDevice(address) } catch (e: Exception) {
                Rig.status("error", "That is not a Bluetooth address.", "", "ble"); return
            }
            val label = found[address] ?: address
            Rig.status("connecting", label, label, "ble")

            var built: BleTransport? = null

            val callback = object : BluetoothGattCallback() {
                override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        g.requestMtu(185)
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        if (Rig.transport === built) Rig.transport = null
                        Rig.status("lost", "Bluetooth disconnected.", label, "ble")
                        try { g.close() } catch (_: Exception) {}
                    }
                }

                override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                    built?.setMtu(maxOf(20, mtu - 3))
                    g.discoverServices()
                }

                override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                    val profile = PROFILES.firstOrNull { g.getService(it.service) != null }
                    if (profile == null) {
                        Rig.status("error",
                            "No serial service on that device. A classic Bluetooth (SPP) module will not appear here — use the SPP option instead.",
                            label, "ble")
                        try { g.disconnect(); g.close() } catch (_: Exception) {}
                        return
                    }
                    val service = g.getService(profile.service)
                    val notify = service.getCharacteristic(profile.notify)
                    val write = service.getCharacteristic(profile.write)
                    if (notify == null) {
                        Rig.status("error", "That device will not send data.", label, "ble")
                        return
                    }
                    g.setCharacteristicNotification(notify, true)
                    val cccd = notify.getDescriptor(UUID.fromString(CCCD))
                    if (cccd != null) {
                        @Suppress("DEPRECATION")
                        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        g.writeDescriptor(cccd)
                    }
                    val transport = BleTransport(g, write, label)
                    built = transport
                    Rig.transport?.close()
                    Rig.transport = transport
                    Rig.status("connected", "$label · ${profile.label}", label, "ble")
                }

                @Suppress("DEPRECATION")
                override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
                    val value = c.value ?: return
                    if (value.isNotEmpty()) Rig.onBytesFromReceiver(value)
                }

                override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
                    if (value.isNotEmpty()) Rig.onBytesFromReceiver(value)
                }
            }

            try {
                device.connectGatt(context, false, callback)
            } catch (e: SecurityException) {
                Rig.status("error", "Bluetooth permission was refused.", label, "ble")
            }
        }
    }
}
