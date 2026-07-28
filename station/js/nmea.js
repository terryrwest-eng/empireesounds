// NMEA 0183 reader for an external receiver.
//
// A ZED-F9P streams NMEA and UBX down the same pipe, so the tokenizer walks the
// byte stream looking for sentences and ignores everything else rather than
// assuming clean lines. Checksums are verified — a corrupt sentence on a long
// cable must never become a coordinate.

export const FIX_QUALITY = {
  0: { label: 'NO FIX',   rank: 0, rtk: false },
  1: { label: 'SINGLE',   rank: 1, rtk: false },
  2: { label: 'DGPS',     rank: 2, rtk: false },
  3: { label: 'PPS',      rank: 2, rtk: false },
  4: { label: 'RTK FIX',  rank: 5, rtk: true },
  5: { label: 'RTK FLOAT', rank: 4, rtk: true },
  6: { label: 'DR',       rank: 1, rtk: false },
  7: { label: 'MANUAL',   rank: 0, rtk: false },
  8: { label: 'SIM',      rank: 0, rtk: false },
  9: { label: 'SBAS',     rank: 2, rtk: false }
};

const KNOTS_TO_MS = 0.514444;

export function checksum(body) {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c;
}

/** ddmm.mmmm + hemisphere -> signed degrees */
export function parseLatLon(value, hemi) {
  if (!value) return null;
  const v = Number(value);
  if (!isFinite(v)) return null;
  const deg = Math.floor(Math.abs(v) / 100);
  const min = Math.abs(v) - deg * 100;
  const dec = deg + min / 60;
  return (hemi === 'S' || hemi === 'W') ? -dec : dec;
}

const num = v => { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };

/**
 * Split a byte or text stream into verified NMEA sentences.
 * Anything that is not a sentence (UBX, RTCM echo, line noise) is dropped.
 */
export class NmeaTokenizer {
  constructor({ maxSentence = 128 } = {}) {
    this.buf = '';
    this.maxSentence = maxSentence;
    this.decoder = new TextDecoder('latin1'); // byte-transparent; UBX bytes cannot throw
    this.badChecksums = 0;
  }
  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const out = [];
    let start;
    while ((start = this.buf.search(/[$!]/)) >= 0) {
      const end = this.buf.indexOf('\n', start);
      if (end < 0) {
        // No terminator yet. Trim anything ahead of the candidate so binary
        // traffic cannot grow the buffer without bound.
        if (start > 0) this.buf = this.buf.slice(start);
        if (this.buf.length > this.maxSentence * 4) this.buf = this.buf.slice(-this.maxSentence);
        break;
      }
      const raw = this.buf.slice(start, end).replace(/[\r\n]+$/, '');
      this.buf = this.buf.slice(end + 1);
      const star = raw.lastIndexOf('*');
      if (star < 1 || raw.length > this.maxSentence * 2) continue;
      const body = raw.slice(1, star);
      const given = parseInt(raw.slice(star + 1, star + 3), 16);
      if (!Number.isNaN(given) && checksum(body) !== given) { this.badChecksums++; continue; }
      out.push(body);
    }
    return out;
  }
}

/**
 * Accumulates sentences into a position. GGA carries the fix, RMC/VTG the
 * motion, GST the real accuracy, GSA the DOPs — a fix is only emitted once GGA
 * lands, so the fields never disagree about which epoch they describe.
 */
export class NmeaReader {
  constructor(onFix) {
    this.onFix = onFix;
    this.tok = new NmeaTokenizer();
    this.state = {
      speed: null, course: null, hdop: null, pdop: null, vdop: null,
      sigmaLat: null, sigmaLon: null, sigmaAlt: null, gstTime: null
    };
    this.counts = {};
    this.lastSentenceAt = 0;
  }

  push(chunk) {
    for (const body of this.tok.push(chunk)) this.sentence(body);
  }

  sentence(body) {
    const f = body.split(',');
    const type = f[0].length === 5 ? f[0].slice(2) : f[0]; // strip the talker id
    this.counts[type] = (this.counts[type] || 0) + 1;
    this.lastSentenceAt = Date.now();
    const s = this.state;

    switch (type) {
      case 'GGA': {
        const lat = parseLatLon(f[2], f[3]);
        const lon = parseLatLon(f[4], f[5]);
        const quality = num(f[6]) ?? 0;
        if (lat == null || lon == null || quality === 0) {
          this.onFix && this.onFix({ time: f[1], quality, lat, lon, valid: false, meta: FIX_QUALITY[quality] || FIX_QUALITY[0] });
          return;
        }
        const hdop = num(f[8]);
        const alt = num(f[9]);              // orthometric (geoid) height
        const geoidSep = num(f[11]);
        const meta = FIX_QUALITY[quality] || FIX_QUALITY[1];

        // GST only describes the epoch it was sent for. Carrying an old one
        // forward would report centimetres from the last RTK fix long after the
        // solution had dropped to single-point.
        const fresh = epochsMatch(f[1], s.gstTime);
        const sigmaH = (fresh && s.sigmaLat != null && s.sigmaLon != null)
          ? Math.hypot(s.sigmaLat, s.sigmaLon)
          : (hdop != null ? hdop * horizontalUere(quality) : null);

        this.onFix && this.onFix({
          valid: true,
          time: f[1],
          lat, lon,
          quality, meta,
          qualityLabel: meta.label,
          sats: num(f[7]),
          hdop, pdop: s.pdop, vdop: s.vdop,
          alt,                                   // metres above the geoid
          geoidSep,
          ellipsoidAlt: (alt != null && geoidSep != null) ? alt + geoidSep : null,
          ageOfDiff: num(f[13]),
          baseId: f[14] || null,
          sigmaH, sigmaV: fresh ? s.sigmaAlt : null,
          accuracy: sigmaH,
          speed: s.speed, course: s.course,
          fromGst: fresh && s.sigmaLat != null
        });
        break;
      }
      case 'RMC':
        s.speed = num(f[7]) != null ? num(f[7]) * KNOTS_TO_MS : s.speed;
        s.course = num(f[8]) ?? s.course;
        break;
      case 'VTG':
        if (num(f[7]) != null) s.speed = num(f[7]) / 3.6;
        else if (num(f[5]) != null) s.speed = num(f[5]) * KNOTS_TO_MS;
        s.course = num(f[1]) ?? s.course;
        break;
      case 'GST':
        s.gstTime = f[1];
        s.sigmaLat = num(f[6]);
        s.sigmaLon = num(f[7]);
        s.sigmaAlt = num(f[8]);
        break;
      case 'GSA':
        s.pdop = num(f[15]);
        s.hdop = num(f[16]);
        s.vdop = num(f[17]);
        break;
    }
  }
}

// UTC time of day from hhmmss.ss
function timeToSeconds(t) {
  if (!t || t.length < 6) return null;
  const h = Number(t.slice(0, 2)), m = Number(t.slice(2, 4)), sec = Number(t.slice(4));
  if (![h, m, sec].every(isFinite)) return null;
  return h * 3600 + m * 60 + sec;
}

// The same epoch, near enough for formatting differences in the time field.
// Deliberately strict: if a receiver sends GST at a lower rate than GGA, the
// epochs in between fall back to a DOP estimate. Reporting a coarser accuracy
// than the truth is safe; reporting a finer one is not.
function epochsMatch(a, b, tol = 0.05) {
  const ta = timeToSeconds(a), tb = timeToSeconds(b);
  if (ta == null || tb == null) return false;
  const d = Math.abs(ta - tb);
  return Math.min(d, 86400 - d) <= tol;
}

// Rough user-equivalent range error, only used when the receiver sends no GST.
function horizontalUere(quality) {
  if (quality === 4) return 0.02;
  if (quality === 5) return 0.3;
  if (quality === 2 || quality === 9) return 1.0;
  return 3.0;
}

/** Build a $GPGGA sentence — NTRIP casters want one to pick a VRS cell. */
export function buildGGA(fix, { talker = 'GP' } = {}) {
  const d = new Date();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const dm = (v, degDigits) => {
    const a = Math.abs(v);
    const deg = Math.floor(a);
    const min = (a - deg) * 60;
    return String(deg).padStart(degDigits, '0') + min.toFixed(5).padStart(8, '0');
  };
  const body = [
    `${talker}GGA`,
    `${hh}${mm}${ss}.00`,
    dm(fix.lat, 2), fix.lat < 0 ? 'S' : 'N',
    dm(fix.lon, 3), fix.lon < 0 ? 'W' : 'E',
    String(fix.quality ?? 1),
    String(fix.sats ?? 10),
    (fix.hdop ?? 1.0).toFixed(1),
    (fix.alt ?? 0).toFixed(2), 'M',
    (fix.geoidSep ?? 0).toFixed(2), 'M',
    '', ''
  ].join(',');
  return `$${body}*${checksum(body).toString(16).toUpperCase().padStart(2, '0')}\r\n`;
}
