// Stationing along a centreline.
//
// The alignment is a densified polyline in local metres. Everything that comes
// out of here — station, offset, tangent bearing — is derived by projecting the
// GPS fix onto that polyline, which is what a chainage readout actually is.

import { azimuth } from './geo.js';

export class Alignment {
  /**
   * @param {number[][]} xy   densified vertices, local metres [[x,y],...]
   * @param {object} opts
   *   staStart   station value at vertex 0, in *display units*
   *   equations  [{ dist: metres from vertex 0, ahead: station value }]
   */
  constructor(xy, opts = {}) {
    this.xy = xy;
    this.name = opts.name || 'Centreline';
    this.staStart = opts.staStart ?? 0;
    this.equations = (opts.equations || []).slice().sort((a, b) => a.dist - b.dist);
    this.unitsPerMetre = opts.unitsPerMetre ?? 1; // display units per metre
    this.cum = [0];
    for (let i = 1; i < xy.length; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    }
    this.length = this.cum[this.cum.length - 1] || 0;
  }

  get lengthDisplay() { return this.length * this.unitsPerMetre; }

  /** Station value (display units) for a distance-along in metres. */
  stationAt(dist) {
    let base = this.staStart, from = 0;
    for (const eq of this.equations) {
      if (dist < eq.dist) break;
      base = eq.ahead; from = eq.dist;
    }
    return base + (dist - from) * this.unitsPerMetre;
  }

  /** Inverse of stationAt — first distance-along that yields this station. */
  distanceAtStation(sta) {
    const spans = [{ dist: 0, ahead: this.staStart }, ...this.equations];
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      const endDist = i + 1 < spans.length ? spans[i + 1].dist : this.length;
      const endSta = s.ahead + (endDist - s.dist) * this.unitsPerMetre;
      const lo = Math.min(s.ahead, endSta), hi = Math.max(s.ahead, endSta);
      if (sta >= lo && sta <= hi) return s.dist + (sta - s.ahead) / this.unitsPerMetre;
    }
    return null;
  }

  /** Point and tangent at a distance-along, in local metres. */
  pointAt(dist) {
    const xy = this.xy;
    if (!xy.length) return null;
    const d = Math.max(0, Math.min(this.length, dist));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < d) i++;
    const segLen = this.cum[i] - this.cum[i - 1] || 1;
    const t = (d - this.cum[i - 1]) / segLen;
    const [ax, ay] = xy[i - 1], [bx, by] = xy[i];
    return {
      x: ax + (bx - ax) * t,
      y: ay + (by - ay) * t,
      bearing: azimuth(bx - ax, by - ay)
    };
  }

  /**
   * Project a point onto the centreline.
   * offset is signed: positive right of increasing station, negative left —
   * matching how offsets are called on plans.
   */
  project(px, py) {
    const xy = this.xy;
    if (xy.length < 2) return null;
    let best = null;
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1], [bx, by] = xy[i];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      const tc = Math.max(0, Math.min(1, t));
      const sx = ax + dx * tc, sy = ay + dy * tc;
      const d2 = (px - sx) ** 2 + (py - sy) ** 2;
      if (!best || d2 < best.d2) {
        best = { d2, i, t, tc, sx, sy, dx, dy, len: Math.sqrt(len2) };
      }
    }
    if (!best) return null;

    const dist = this.cum[best.i - 1] + best.tc * best.len;
    // sign convention: cross product of tangent x (point - foot)
    const cross = best.dx * (py - best.sy) - best.dy * (px - best.sx);
    const mag = Math.sqrt(best.d2);
    const offset = cross < 0 ? mag : -mag; // right of tangent -> cross < 0 in ENU

    let beyond = 0;
    if (best.i === 1 && best.t < 0) beyond = best.t * best.len;                       // before BOA
    if (best.i === xy.length - 1 && best.t > 1) beyond = (best.t - 1) * best.len;     // past EOA

    return {
      dist,
      station: this.stationAt(dist),
      offset,
      offsetDisplay: offset * this.unitsPerMetre,
      distance: mag,
      snap: [best.sx, best.sy],
      bearing: azimuth(best.dx, best.dy),
      beyond: beyond * this.unitsPerMetre,
      onLine: beyond === 0
    };
  }

  bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of this.xy) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  toJSON() {
    return {
      xy: this.xy, name: this.name, staStart: this.staStart,
      equations: this.equations, unitsPerMetre: this.unitsPerMetre
    };
  }
  static from(o) { return o ? new Alignment(o.xy, o) : null; }
}

/* ---------- station formatting ---------- */

// 1250.25 ft -> "12+50.25"   ·   1250.25 m -> "1+250.25"
export function formatStation(value, interval = 100, decimals = 2) {
  if (value == null || !isFinite(value)) return '—';
  const neg = value < 0;
  const v = Math.abs(value);
  const whole = Math.floor(v / interval);
  let rem = v - whole * interval;
  // guard the rounding edge: 99.999 -> 100.00 must roll the station up
  if (Number(rem.toFixed(decimals)) >= interval) return formatStation((neg ? -1 : 1) * (whole + 1) * interval, interval, decimals);
  const pad = String(interval - 1).length;
  const rs = rem.toFixed(decimals).padStart(pad + (decimals ? decimals + 1 : 0), '0');
  return `${neg ? '-' : ''}${whole}+${rs}`;
}

// Accepts "12+50.25", "1250.25", "12+50", "-1+00"
export function parseStation(text, interval = 100) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  const m = s.match(/^(-)?\s*(\d+)\s*\+\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const v = Number(m[2]) * interval + Number(m[3]);
    return m[1] ? -v : v;
  }
  const n = Number(s.replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

export function formatOffset(off, label, decimals = 2) {
  if (off == null || !isFinite(off)) return '—';
  const a = Math.abs(off);
  if (a < 0.005) return `ON ℄`;
  return `${a.toFixed(decimals)} ${label} ${off > 0 ? 'RT' : 'LT'}`;
}

/* ---------- polyline helpers ---------- */

// Drop vertices that add nothing, so a 200k-point GPX track still draws fast.
export function simplify(points, tol = 0.15) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = points[s], [bx, by] = points[e];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let idx = -1, max = tol;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = points[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
      }
      if (d > max) { max = d; idx = i; }
    }
    if (idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

export function polylineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}
