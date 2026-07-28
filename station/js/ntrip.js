// NTRIP client. Talks to the relay on our own server, which holds the TCP
// connection to the caster.
//
// Corrections are pulled as a byte stream and handed straight to the rover; the
// only thing this file understands about RTCM is where one message ends and the
// next begins, so the mountpoint's message list can be shown for diagnosis.

export class NtripClient {
  constructor({ onRtcm, onStatus, onStats } = {}) {
    this.onRtcm = onRtcm || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onStats = onStats || (() => {});
    this.connected = false;
    this.wanted = false;
    this.bytes = 0;
    this.lastDataAt = 0;
    this.rtcmTypes = new Map();
    this.session = null;
    this.retries = 0;
    this._abort = null;
    this._ggaTimer = null;
    this._framer = new RtcmFramer(type => {
      this.rtcmTypes.set(type, (this.rtcmTypes.get(type) || 0) + 1);
    });
  }

  static auth(user, pass) {
    if (!user && !pass) return '';
    return btoa(`${user || ''}:${pass || ''}`);
  }

  async status() {
    const res = await fetch('ntrip/status', { cache: 'no-store' });
    return res.json();
  }

  /** Fetch and parse the caster's mountpoint table. */
  async sourcetable({ host, port = 2101, tls = false, user, pass }) {
    const q = new URLSearchParams({ host, port: String(port) });
    if (tls) q.set('tls', '1');
    const res = await fetch(`ntrip/sourcetable?${q}`, {
      cache: 'no-store',
      headers: authHeaders(user, pass)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(safeError(text, 'The caster would not send its mountpoint list.'));
    return parseSourcetable(text);
  }

  connect(opts) {
    this.opts = opts;
    this.wanted = true;
    this.retries = 0;
    this._run();
  }

  disconnect() {
    this.wanted = false;
    this.connected = false;
    clearTimeout(this._ggaTimer);
    clearTimeout(this._retryTimer);
    try { this._abort?.abort(); } catch {}
    this._abort = null;
    this.onStatus({ state: 'off' });
  }

  async _run() {
    if (!this.wanted) return;
    const { host, port = 2101, mount, user, pass, tls = false, gga, ggaInterval = 10000 } = this.opts;
    this.session = randomId();
    const q = new URLSearchParams({ host, port: String(port), mount, session: this.session });
    if (tls) q.set('tls', '1');

    const ac = new AbortController();
    this._abort = ac;
    this.onStatus({ state: 'connecting', mount });

    try {
      const headers = authHeaders(user, pass);
      const first = typeof gga === 'function' ? gga() : gga;
      if (first) headers['X-Ntrip-Gga'] = first.replace(/[\r\n]/g, '');

      const res = await fetch(`ntrip/stream?${q}`, { cache: 'no-store', headers, signal: ac.signal });
      if (!res.ok || !res.body) {
        throw new Error(safeError(await res.text(), `The caster refused the connection (${res.status}).`));
      }

      this.connected = true;
      this.retries = 0;
      this.onStatus({ state: 'on', mount, session: this.session });
      this._scheduleGga(ggaInterval);

      const reader = res.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        this.bytes += value.length;
        this.lastDataAt = Date.now();
        this._framer.push(value);
        this.onRtcm(value);
        this.onStats(this.stats());
      }
      throw new Error('The caster closed the connection.');
    } catch (err) {
      this.connected = false;
      clearTimeout(this._ggaTimer);
      if (!this.wanted || err.name === 'AbortError') { this.onStatus({ state: 'off' }); return; }
      // Casters drop connections routinely; keep coming back, slower each time.
      const wait = Math.min(30000, 2000 * 2 ** this.retries++);
      this.onStatus({ state: 'retrying', detail: err.message, inMs: wait });
      this._retryTimer = setTimeout(() => this._run(), wait);
    }
  }

  _scheduleGga(interval) {
    clearTimeout(this._ggaTimer);
    const tick = async () => {
      if (!this.wanted || !this.connected) return;
      const gga = typeof this.opts.gga === 'function' ? this.opts.gga() : this.opts.gga;
      if (gga) {
        try {
          await fetch(`ntrip/gga?session=${encodeURIComponent(this.session)}`, {
            method: 'POST', cache: 'no-store', body: gga
          });
        } catch { /* the stream itself will report a real outage */ }
      }
      this._ggaTimer = setTimeout(tick, interval);
    };
    this._ggaTimer = setTimeout(tick, 1000);
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

function authHeaders(user, pass) {
  const auth = NtripClient.auth(user, pass);
  return auth ? { 'X-Ntrip-Auth': auth } : {};
}

function safeError(text, fallback) {
  try { const j = JSON.parse(text); if (j && j.error) return j.error; } catch {}
  return fallback;
}

const randomId = () => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map(v => v.toString(16).padStart(2, '0')).join('');
};

/* ---------------- sourcetable ---------------- */

const STR_FIELDS = ['mount', 'identifier', 'format', 'formatDetails', 'carrier', 'navSystem',
  'network', 'country', 'lat', 'lon', 'nmea', 'solution', 'generator', 'compression',
  'authentication', 'fee', 'bitrate', 'misc'];

export function parseSourcetable(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('STR;')) continue;
    const parts = line.split(';').slice(1);
    const e = {};
    STR_FIELDS.forEach((k, i) => { e[k] = parts[i] ?? ''; });
    e.lat = Number(e.lat) || null;
    e.lon = Number(e.lon) || null;
    e.needsGga = e.nmea === '1';         // VRS / nearest-base mountpoints
    e.needsAuth = /^[BD]$/i.test(e.authentication);
    entries.push(e);
  }
  return entries;
}

/** Distance in km, for sorting mountpoints by how close the base is. */
export function casterDistanceKm(entry, lat, lon) {
  if (entry.lat == null || entry.lon == null || lat == null) return null;
  const r = Math.PI / 180, R = 6371;
  const dLat = (entry.lat - lat) * r, dLon = (entry.lon - lon) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * r) * Math.cos(entry.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ---------------- RTCM 3 framing ---------------- */

// Only enough to count message types: preamble 0xD3, 10-bit length, then the
// 12-bit message number at the head of the payload.
export class RtcmFramer {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buf = new Uint8Array(0);
  }
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    let i = 0;
    while (i + 6 <= merged.length) {
      if (merged[i] !== 0xd3) { i++; continue; }
      const len = ((merged[i + 1] & 0x03) << 8) | merged[i + 2];
      const total = len + 6; // header 3 + payload + CRC 3
      if (i + total > merged.length) break;
      if (len >= 2) this.onMessage((merged[i + 3] << 4) | (merged[i + 4] >> 4));
      i += total;
    }
    this.buf = merged.subarray(i);
    if (this.buf.length > 8192) this.buf = this.buf.subarray(this.buf.length - 1024);
  }
}
