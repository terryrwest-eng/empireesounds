package com.empiresounds.station

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbManager
import androidx.core.content.ContextCompat
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import org.json.JSONObject

/**
 * USB serial. On an ArduSimple this is the ZED-F9P's own USB port over an OTG
 * cable — the steadiest link there is, and it powers the board.
 *
 * The chip-level drivers come from usb-serial-for-android: CDC-ACM for the F9P's
 * native USB, plus CP210x, CH34x, FTDI and PL2303 for the boards that put a
 * bridge in front. Hand-rolling those is the one part of this app that cannot be
 * checked without every chip on the desk, so it uses the library everyone else
 * does.
 */
class UsbSerialTransport private constructor(
    private val port: UsbSerialPort,
    override val name: String
) : Transport {

    override val kind = "usb"
    private var io: SerialInputOutputManager? = null

    override fun write(bytes: ByteArray) {
        port.write(bytes, WRITE_TIMEOUT_MS)
    }

    override fun close() {
        try { io?.stop() } catch (_: Exception) {}
        io = null
        try { port.close() } catch (_: Exception) {}
    }

    private fun startReading() {
        val manager = SerialInputOutputManager(port, object : SerialInputOutputManager.Listener {
            override fun onNewData(data: ByteArray) {
                if (data.isNotEmpty()) Rig.onBytesFromReceiver(data)
            }

            override fun onRunError(e: Exception) {
                Rig.status("lost", e.message ?: "USB read failed", name, "usb")
                if (Rig.transport === this@UsbSerialTransport) {
                    Rig.transport = null
                    close()
                }
            }
        })
        manager.readTimeout = READ_TIMEOUT_MS
        io = manager
        manager.start()
    }

    companion object {
        private const val WRITE_TIMEOUT_MS = 2000
        private const val READ_TIMEOUT_MS = 200
        private const val ACTION_PERMISSION = "com.empiresounds.station.USB_PERMISSION"

        fun list(context: Context): List<JSONObject> {
            val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
            return UsbSerialProber.getDefaultProber().findAllDrivers(manager).mapIndexed { i, driver ->
                val d = driver.device
                JSONObject()
                    .put("id", d.deviceName)
                    .put("name", d.productName ?: "USB device ${i + 1}")
                    .put("detail", "${d.manufacturerName ?: "USB"} · ${hex(d.vendorId)}:${hex(d.productId)}")
            }
        }

        private fun hex(v: Int) = String.format("%04x", v)

        /**
         * Opens a port, asking for USB permission first if Android has not
         * already granted it. Asynchronous by nature — the permission dialog is
         * the user's, not ours — so the result arrives as a status event.
         */
        fun connect(context: Context, deviceId: String?, baudRate: Int) {
            val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
            val drivers = UsbSerialProber.getDefaultProber().findAllDrivers(manager)
            if (drivers.isEmpty()) {
                Rig.status("error", "No USB serial device found. Check the OTG cable and that the receiver is powered.", "", "usb")
                return
            }
            val driver = (if (deviceId == null) drivers.first()
            else drivers.firstOrNull { it.device.deviceName == deviceId }) ?: run {
                Rig.status("error", "That USB device is no longer attached.", "", "usb")
                return
            }

            val label = driver.device.productName ?: "USB receiver"
            if (manager.hasPermission(driver.device)) {
                open(driver, label, baudRate)
                return
            }

            Rig.status("connecting", "Waiting for USB permission…", label, "usb")
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    if (intent.action != ACTION_PERMISSION) return
                    try { ctx.unregisterReceiver(this) } catch (_: Exception) {}
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (granted) open(driver, label, baudRate)
                    else Rig.status("error", "USB permission was refused.", label, "usb")
                }
            }
            ContextCompat.registerReceiver(
                context, receiver, IntentFilter(ACTION_PERMISSION), ContextCompat.RECEIVER_NOT_EXPORTED
            )
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val pending = PendingIntent.getBroadcast(
                context, 0, Intent(ACTION_PERMISSION).setPackage(context.packageName), flags
            )
            manager.requestPermission(driver.device, pending)
        }

        private fun open(driver: UsbSerialDriver, label: String, baudRate: Int) {
            val context = App.context
            val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
            val connection = manager.openDevice(driver.device)
            if (connection == null) {
                Rig.status("error", "Android would not open that USB device.", label, "usb")
                return
            }
            val port = driver.ports.firstOrNull()
            if (port == null) {
                Rig.status("error", "That device has no serial port on it.", label, "usb")
                return
            }
            try {
                port.open(connection)
                port.setParameters(baudRate, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
                // The F9P's native USB ignores these; a bridge chip needs them.
                try { port.dtr = true } catch (_: Exception) {}
                try { port.rts = true } catch (_: Exception) {}
            } catch (e: Exception) {
                try { port.close() } catch (_: Exception) {}
                Rig.status("error", e.message ?: "Could not open the USB port.", label, "usb")
                return
            }

            val transport = UsbSerialTransport(port, label)
            Rig.transport?.close()
            Rig.transport = transport
            transport.startReading()
            Rig.status("connected", "$label · USB $baudRate", label, "usb")
        }
    }
}
