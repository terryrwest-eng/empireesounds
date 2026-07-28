// Geodesy helpers. Everything internal is metres in a local tangent plane —
// project-scale work (a few km) stays sub-centimetre against the ellipsoid,
// and it keeps the stationing math to plain 2D vectors.

export const M_PER_INTL_FT = 0.3048;
export const M_PER_US_FT = 1200 / 3937; // 0.3048006096...

export const UNITS = {
  meter:     { m: 1, label: 'm', name: 'Metres' },
  foot:      { m: M_PER_INTL_FT, label: 'ft', name: 'Feet (international)' },
  usfoot:    { m: M_PER_US_FT, label: 'ft', name: 'Feet (US survey)' }
};

// Metres per degree at a given latitude (WGS-84 series expansion).
export function metresPerDegree(latDeg) {
  const p = latDeg * Math.PI / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p)
  };
}

// East-north-up tangent plane anchored on one point. x = east, y = north.
export class LocalFrame {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    const s = metresPerDegree(lat0);
    this.mLat = s.lat;
    this.mLon = s.lon;
  }
  toXY(lat, lon) {
    return [(lon - this.lon0) * this.mLon, (lat - this.lat0) * this.mLat];
  }
  toLL(x, y) {
    return { lat: this.lat0 + y / this.mLat, lon: this.lon0 + x / this.mLon };
  }
  toJSON() { return { lat0: this.lat0, lon0: this.lon0 }; }
  static from(o) { return o ? new LocalFrame(o.lat0, o.lon0) : null; }
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Grid azimuth, degrees clockwise from north, given an east/north vector.
export function azimuth(dx, dy) {
  let a = Math.atan2(dx, dy) * 180 / Math.PI;
  return a < 0 ? a + 360 : a;
}

// Surveyor's quadrant bearing, e.g. N 42°17'30" E
export function quadrantBearing(az, { seconds = true } = {}) {
  let quad, ang;
  if (az <= 90)       { quad = ['N', 'E']; ang = az; }
  else if (az <= 180) { quad = ['S', 'E']; ang = 180 - az; }
  else if (az <= 270) { quad = ['S', 'W']; ang = az - 180; }
  else                { quad = ['N', 'W']; ang = 360 - az; }

  // Round in the smallest unit shown, then carry — otherwise 89.99999°
  // prints as 89°59'60".
  const pad = n => String(n).padStart(2, '0');
  if (seconds) {
    let s = Math.round(ang * 3600);
    const d = Math.floor(s / 3600); s -= d * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    return `${quad[0]} ${d}°${pad(m)}'${pad(s)}" ${quad[1]}`;
  }
  let m = Math.round(ang * 60);
  const d = Math.floor(m / 60); m -= d * 60;
  return `${quad[0]} ${d}°${pad(m)}' ${quad[1]}`;
}

// Least-squares 2D similarity (Helmert) fit: source grid -> target metres.
// Two point pairs solve it exactly; more pairs get averaged and the residuals
// tell you whether the control is any good.
export function fitSimilarity(pairs) {
  const n = pairs.length;
  if (n < 1) return null;
  const mean = (sel) => pairs.reduce((s, p) => s + sel(p), 0) / n;
  const ux = mean(p => p.src[0]), uy = mean(p => p.src[1]);
  const tx = mean(p => p.dst[0]), ty = mean(p => p.dst[1]);

  if (n === 1) return { a: 1, b: 0, tx: tx - ux, ty: ty - uy, scale: 1, rotation: 0, rms: 0, residuals: [0] };

  let num1 = 0, num2 = 0, den = 0;
  for (const p of pairs) {
    const u = p.src[0] - ux, v = p.src[1] - uy;
    const x = p.dst[0] - tx, y = p.dst[1] - ty;
    num1 += u * x + v * y;
    num2 += u * y - v * x;
    den += u * u + v * v;
  }
  if (den === 0) return null;
  const a = num1 / den, b = num2 / den;
  const t = {
    a, b,
    tx: tx - (a * ux - b * uy),
    ty: ty - (b * ux + a * uy),
    scale: Math.hypot(a, b),
    rotation: azimuth(b, a) // clockwise rotation applied to grid north
  };
  const residuals = pairs.map(p => {
    const [x, y] = applySimilarity(t, p.src[0], p.src[1]);
    return Math.hypot(x - p.dst[0], y - p.dst[1]);
  });
  t.residuals = residuals;
  t.rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
  return t;
}

export function applySimilarity(t, x, y) {
  return [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty];
}
