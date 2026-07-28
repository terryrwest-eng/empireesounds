// Talking to an external GNSS receiver from the browser.
//
// Three ways in, depending on what the device is and what the browser exposes:
//   USB   — WebUSB against a CDC-ACM port. This is the ZED-F9P's native USB, so
//           an ArduSimple simpleRTK2B on an OTG cable lands here.
//   BLE   — Web Bluetooth, serial-over-BLE profiles. Classic Bluetooth SPP (the
//           XBee Bluetooth module) is NOT reachable from any browser.
//   Serial— Web Serial, for a laptop.
//
// Every transport is bidirectional: NMEA comes up, RTCM corrections go down.

const CDC_SET_LINE_CODING = 0x20;
const CDC_SET_CONTROL_LINE_STATE = 0x22;

// Serial-over-BLE profiles worth trying, most likely first.
const BLE_PROFILES = [
  { name: 'Nordic UART', service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e' },
  { name: 'u-blox SPS',  service: '2456e1b9-26e2-8f83-e744-f34f01e9d701', rx: '2456e1b9-26e2-8f83-e744-f34f01e9d703', tx: '2456e1b9-26e2-8f83-e744-f34f01e9d702' },
  { name: 'HM-10',       service: 0xffe0, rx: 0xffe1, tx: 0xffe1 },
  { name: 'Feasycom',    service: 0xffe5, rx: 0xffe9, tx: 0xffe4 }
];

const USB_FILTERS = [
  { vendorId: 0x1546 },              // u-blox (ZED-F9P native USB)
  { classCode: 0x02 },               // CDC control
  { classCode: 0x0a }                // CDC data
];

export const support = {
  usb: typeof navigator !== 'undefined' && !!navigator.usb,
  serial: typeof navigator !== 'undefined' && !!navigator.serial,
  ble: typeof navigator !== 'undefined' && !!navigator.bluetooth
};

export class RoverLink {
  constructor({ onData, onStatus } = {}) {
    this.onData = onData || (() => {});
    this.onStatus = onStatus || (() => {});
    this.kind = null;
    this.name = '';
    this.connected = false;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this._stop = false;
  }

  status(state, detail = '') { this.onStatus({ state, detail, name: this.name, kind: this.kind }); }

  async connect(kind, opts = {}) {
    await this.disconnect();
    this._stop = false;
    this.kind = kind;
    if (kind === 'usb') return this._connectUsb(opts);
    if (kind === 'serial') return this._connectSerial(opts);
    if (kind === 'ble') return this._connectBle(opts);
    throw new Error(`Unknown connection type: ${kind}`);
  }

  async disconnect() {
    this._stop = true;
    this.connected = false;
    try { await this._closeFns?.reduce((p, fn) => p.then(fn).catch(() => {}), Promise.resolve()); } catch {}
    this._closeFns = [];
    this._write = null;
  }

  async write(bytes) {
    if (!this._write || !this.connected) return false;
    try {
      await this._write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      this.bytesOut += bytes.length;
      return true;
    } catch (e) {
      this.status('error', `Write failed: ${e.message}`);
      return false;
    }
  }

  _got(chunk) {
    this.bytesIn += chunk.byteLength ?? chunk.length ?? 0;
    this.onData(chunk);
  }

  /* ---------------- WebUSB (CDC-ACM) ---------------- */

  async _connectUsb({ baudRate = 38400 } = {}) {
    if (!navigator.usb) throw new Error('This browser has no WebUSB. Use Chrome on Android, or a desktop.');
    const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    this.name = [device.manufacturerName, device.productName].filter(Boolean).join(' ') || 'USB device';
    this.status('connecting', this.name);

    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);

    // Find the CDC data interface (bulk in + bulk out) and its control sibling.
    let dataIface = null, dataAlt = null, ctrlIface = null;
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 0x0a && !dataIface) { dataIface = iface; dataAlt = alt; }
        if (alt.interfaceClass === 0x02 && ctrlIface == null) ctrlIface = iface.interfaceNumber;
      }
    }
    if (!dataIface) {
      // Some boards expose a vendor-specific interface holding the bulk pair.
      for (const iface of device.configuration.interfaces) {
        for (const alt of iface.alternates) {
          const hasIn = alt.endpoints.some(e => e.direction === 'in' && e.type === 'bulk');
          const hasOut = alt.endpoints.some(e => e.direction === 'out' && e.type === 'bulk');
          if (hasIn && hasOut && !dataIface) { dataIface = iface; dataAlt = alt; }
        }
      }
    }
    if (!dataIface) { await device.close(); throw new Error('No serial (CDC) interface on that device.'); }

    const epIn = dataAlt.endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
    const epOut = dataAlt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
    if (!epIn) { await device.close(); throw new Error('That device has no bulk IN endpoint to read from.'); }

    if (ctrlIface != null) { try { await device.claimInterface(ctrlIface); } catch {} }
    await device.claimInterface(dataIface.interfaceNumber);

    // Line coding is advisory on the F9P's native USB but required by bridges.
    if (ctrlIface != null) {
      const coding = new DataView(new ArrayBuffer(7));
      coding.setUint32(0, baudRate, true);
      coding.setUint8(4, 0); // 1 stop bit
      coding.setUint8(5, 0); // no parity
      coding.setUint8(6, 8); // 8 data bits
      try {
        await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: CDC_SET_LINE_CODING, value: 0, index: ctrlIface }, coding.buffer);
        await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: CDC_SET_CONTROL_LINE_STATE, value: 0x03, index: ctrlIface });
      } catch { /* native USB CDC often NAKs these; harmless */ }
    }

    this._write = epOut
      ? async bytes => { await device.transferOut(epOut.endpointNumber, bytes); }
      : null;
    this._closeFns = [
      async () => { try { await device.releaseInterface(dataIface.interfaceNumber); } catch {} },
      async () => { await device.close(); }
    ];
    this.connected = true;
    this.status('connected', `${this.name} · USB`);

    const size = epIn.packetSize || 64;
    (async () => {
      while (!this._stop) {
        let res;
        try { res = await device.transferIn(epIn.endpointNumber, size * 8); }
        catch (e) { if (!this._stop) this.status('lost', e.message); break; }
        if (res.status === 'stall') { try { await device.clearHalt('in', epIn.endpointNumber); } catch {} continue; }
        if (res.data && res.data.byteLength) this._got(new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength));
      }
      this.connected = false;
    })();
    return true;
  }

  /* ---------------- Web Serial ---------------- */

  async _connectSerial({ baudRate = 38400 } = {}) {
    if (!navigator.serial) throw new Error('This browser has no Web Serial. On a phone, use USB or Bluetooth.');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 8192 });
    const info = port.getInfo?.() || {};
    this.name = info.usbVendorId ? `Serial ${hex(info.usbVendorId)}:${hex(info.usbProductId)}` : 'Serial port';

    const writer = port.writable ? port.writable.getWriter() : null;
    this._write = writer ? async bytes => { await writer.write(bytes); } : null;
    this._closeFns = [
      async () => { try { writer && writer.releaseLock(); } catch {} },
      async () => { try { await this._reader?.cancel(); } catch {} },
      async () => { await port.close(); }
    ];
    this.connected = true;
    this.status('connected', `${this.name} · ${baudRate} baud`);

    (async () => {
      const reader = port.readable.getReader();
      this._reader = reader;
      try {
        while (!this._stop) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this._got(value);
        }
      } catch (e) { if (!this._stop) this.status('lost', e.message); }
      finally { try { reader.releaseLock(); } catch {} this.connected = false; }
    })();
    return true;
  }

  /* ---------------- Web Bluetooth (BLE only) ---------------- */

  async _connectBle() {
    if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth.');
    const device = await navigator.bluetooth.requestDevice({
      filters: BLE_PROFILES.map(p => ({ services: [p.service] })),
      optionalServices: BLE_PROFILES.map(p => p.service)
    });
    this.name = device.name || 'BLE device';
    this.status('connecting', this.name);
    const server = await device.gatt.connect();

    let profile = null, service = null;
    for (const p of BLE_PROFILES) {
      try { service = await server.getPrimaryService(p.service); profile = p; break; } catch {}
    }
    if (!service) { device.gatt.disconnect(); throw new Error('No serial service on that device. Classic Bluetooth SPP modules cannot be used from a browser.'); }

    const notify = await service.getCharacteristic(profile.tx);
    let writeChar = null;
    try { writeChar = await service.getCharacteristic(profile.rx); } catch {}

    const onNotify = e => this._got(new Uint8Array(e.target.value.buffer));
    notify.addEventListener('characteristicvaluechanged', onNotify);
    await notify.startNotifications();

    // BLE writes are MTU-limited; chunk so an RTCM frame does not get dropped.
    this._write = writeChar ? async bytes => {
      for (let i = 0; i < bytes.length; i += 20) {
        const slice = bytes.subarray(i, i + 20);
        if (writeChar.writeValueWithoutResponse) await writeChar.writeValueWithoutResponse(slice);
        else await writeChar.writeValue(slice);
      }
    } : null;

    const onGone = () => { this.connected = false; this.status('lost', 'Bluetooth disconnected'); };
    device.addEventListener('gattserverdisconnected', onGone);
    this._closeFns = [
      async () => { device.removeEventListener('gattserverdisconnected', onGone); },
      async () => { try { await notify.stopNotifications(); } catch {} notify.removeEventListener('characteristicvaluechanged', onNotify); },
      async () => { device.gatt.disconnect(); }
    ];
    this.connected = true;
    this.status('connected', `${this.name} · ${profile.name}`);
    return true;
  }
}

const hex = v => (v == null ? '????' : v.toString(16).padStart(4, '0'));
