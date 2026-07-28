// Bridge to the Android shell.
//
// When Station runs inside the native app the hardware is Android's problem, and
// this file makes that look exactly like the browser transports so the rest of
// the app does not care which it is talking to.
//
// The contract, both directions:
//
//   window.AndroidStation      injected by the shell. Every method takes and
//                              returns a string, because that is all a
//                              JavascriptInterface can carry, and every one of
//                              them returns immediately — anything slow reports
//                              back as an event instead of blocking the page.
//     appInfo()            -> {ok, version, android, model}
//     listTransports()     -> {ok, transports:["usb","spp","ble"]}
//     listDevices(kind)    -> {ok, devices:[{id,name,detail}]}   (ble also scans)
//     connect(json)        -> {ok, pending:true}  then a "status" event
//     write(base64)        -> {ok}
//     disconnect()         -> {ok}
//     sourcetable(json)    -> {ok, pending:true}  then a "sourcetable" event
//     ntripConnect(json)   -> {ok, pending:true}  then "ntrip" / "ntripStats"
//     ntripDisconnect()    -> {ok}
//
//   window.AndroidStationEvent(json)   called by the shell; defined here.
//
// Receiver bytes come up as base64. RTCM never comes down this way — the shell
// pipes corrections from the caster straight to the receiver, so a slow page
// cannot stall a correction stream.

const bridge = typeof window !== 'undefined' ? window.AndroidStation : null;

export const isNative = !!bridge;

const listeners = new Set();

if (typeof window !== 'undefined') {
  window.AndroidStationEvent = json => {
    let event;
    try { event = JSON.parse(json); } catch { return; }
    for (const fn of [...listeners]) {
      try { fn(event); } catch (e) { console.error(e); }
    }
  };
}

export function onNativeEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolves on the first event matching `match`, or rejects on timeout. */
function nextEvent(match, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const stop = onNativeEvent(e => {
      if (!match(e)) return;
      clearTimeout(timer);
      stop();
      resolve(e);
    });
    const timer = setTimeout(() => { stop(); reject(new Error(timeoutMessage)); }, timeoutMs);
  });
}

function call(method, arg) {
  if (!bridge || typeof bridge[method] !== 'function') {
    return { ok: false, error: `This build of the app has no ${method}.` };
  }
  try {
    const raw = arg === undefined
      ? bridge[method]()
      : bridge[method](typeof arg === 'string' ? arg : JSON.stringify(arg));
    return raw ? JSON.parse(raw) : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

export function nativeInfo() {
  return bridge ? call('appInfo') : null;
}

export function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

const randomId = () => Math.random().toString(36).slice(2, 10);

/** Same shape as RoverLink, backed by the Android transports. */
export class NativeLink {
  constructor({ onData, onStatus, onDevices } = {}) {
    this.onData = onData || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onDevices = onDevices || (() => {});
    this.kind = null;
    this.name = '';
    this.connected = false;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.deviceCache = {};
    onNativeEvent(e => this._event(e));
  }

  _event(e) {
    if (e.type === 'data') {
      const bytes = decodeBase64(e.b64);
      this.bytesIn += bytes.length;
      this.onData(bytes);
    } else if (e.type === 'status') {
      this.connected = e.state === 'connected';
      if (e.name) this.name = e.name;
      if (e.kind) this.kind = e.kind;
      this.onStatus({ state: e.state, detail: e.detail || '', name: this.name, kind: this.kind });
    } else if (e.type === 'devices') {
      this.deviceCache[e.kind] = e.devices || [];
      this.onDevices(e.kind, this.deviceCache[e.kind], !!e.done);
    }
  }

  transports() {
    const r = call('listTransports');
    return r.ok ? (r.transports || []) : [];
  }

  /**
   * USB and paired Bluetooth are known instantly. BLE needs a scan, so this
   * returns what is known so far and more arrive as `devices` events.
   */
  devices(kind) {
    const r = call('listDevices', kind);
    if (!r.ok) throw new Error(r.error || 'Could not list devices.');
    this.deviceCache[kind] = r.devices || [];
    return this.deviceCache[kind];
  }

  async connect(kind, opts = {}) {
    this.kind = kind;
    const settled = nextEvent(
      e => e.type === 'status' && (e.state === 'connected' || e.state === 'error' || e.state === 'lost'),
      90000, // the USB permission dialog is the user's to answer
      'The receiver did not answer. Check the cable or the pairing and try again.'
    );
    const r = call('connect', { kind, ...opts });
    if (!r.ok) throw new Error(r.error || 'The app could not open that connection.');
    const e = await settled;
    if (e.state !== 'connected') throw new Error(e.detail || 'The connection failed.');
    this.connected = true;
    if (e.name) this.name = e.name;
    return true;
  }

  async disconnect() {
    call('disconnect');
    this.connected = false;
  }

  async write(bytes) {
    if (!this.connected) return false;
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const r = call('write', encodeBase64(array));
    if (r.ok) this.bytesOut += array.length;
    return !!r.ok;
  }
}

/**
 * Same shape as NtripClient, but the shell holds the socket: it dials the caster
 * over TCP and feeds the receiver directly — no relay, nothing to marshal, and
 * corrections keep flowing while the screen is off.
 */
export class NativeNtrip {
  constructor({ onStatus, onStats } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onStats = onStats || (() => {});
    this.wanted = false;
    this.connected = false;
    this.bytes = 0;
    this.lastDataAt = 0;
    this.rtcmTypes = new Map();
    onNativeEvent(e => this._event(e));
  }

  _event(e) {
    if (e.type === 'ntrip') {
      this.connected = e.state === 'on';
      if (e.state === 'off') this.wanted = false;
      this.onStatus({ state: e.state, detail: e.detail || '', mount: e.mount, inMs: e.inMs || 0 });
    } else if (e.type === 'ntripStats') {
      this.bytes = e.bytes || 0;
      this.lastDataAt = e.lastDataAt || 0;
      this.rtcmTypes = new Map((e.types || []).map(([t, n]) => [t, n]));
      this.onStats(this.stats());
    }
  }

  async status() { return { enabled: true, native: true, sessions: this.connected ? 1 : 0 }; }

  async sourcetable(opts) {
    const requestId = randomId();
    const answer = nextEvent(
      e => e.type === 'sourcetable' && e.requestId === requestId,
      25000,
      'The caster did not send its mountpoint list in time.'
    );
    const r = call('sourcetable', {
      requestId, host: opts.host, port: opts.port, tls: !!opts.tls,
      user: opts.user || '', pass: opts.pass || ''
    });
    if (!r.ok) throw new Error(r.error || 'Could not reach the caster.');
    const e = await answer;
    if (!e.ok) throw new Error(e.error || 'The caster would not send its mountpoint list.');
    const { parseSourcetable } = await import('./ntrip.js');
    return parseSourcetable(e.text || '');
  }

  connect(opts) {
    this.wanted = true;
    const r = call('ntripConnect', {
      host: opts.host, port: opts.port, mount: opts.mount,
      user: opts.user || '', pass: opts.pass || '', tls: !!opts.tls,
      ggaIntervalMs: opts.ggaInterval || 10000
    });
    if (!r.ok) {
      this.wanted = false;
      this.onStatus({ state: 'off', detail: r.error || 'Could not reach the caster.' });
    }
  }

  disconnect() {
    this.wanted = false;
    this.connected = false;
    call('ntripDisconnect');
    this.onStatus({ state: 'off' });
  }

  stats() {
    return {
      connected: this.connected,
      bytes: this.bytes,
      lastDataAt: this.lastDataAt,
      ageMs: this.lastDataAt ? Date.now() - this.lastDataAt : null,
      types: [...this.rtcmTypes.entries()].sort((a, b) => a[0] - b[0])
    };
  }
}
