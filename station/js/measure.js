// Tape measure and planimeter.
//
// Everything here works on local-tangent-plane metres, the same frame the
// stationing uses, so a measurement and a station always agree with each other.
// Distances are horizontal unless a slope distance is asked for — that is the
// convention on a plan, and quoting a slope distance as a length is how fences
// end up short.

import { azimuth } from './geo.js';

export const M2_PER_HECTARE = 10000;

// Which foot the project is on. The US survey foot and the international foot
// differ by 2 ppm — 0.01 ft in a mile, and about 0.17 ft² in an acre — so the
// acre is derived from whichever is in use rather than hard-coded. Set once
// from the unit setting; there is only ever one project open.
let FOOT = 1200 / 3937; // US survey foot, the default on US plans

export function setFootMetres(metres) {
  if (metres > 0) FOOT = metres;
}
export function footMetres() { return FOOT; }
/** 43 560 square feet, in whichever foot is in use. */
export function acreMetres2() { return 43560 * FOOT * FOOT; }

/** Horizontal length of each leg, with the bearing and grade that go with it. */
export function segments(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const horizontal = Math.hypot(dx, dy);
    const dz = (a.ele != null && b.ele != null) ? b.ele - a.ele : null;
    out.push({
      from: i - 1,
      to: i,
      horizontal,
      bearing: azimuth(dx, dy),
      dz,
      slopeDistance: dz == null ? horizontal : Math.hypot(horizontal, dz),
      grade: (dz == null || horizontal === 0) ? null : dz / horizontal
    });
  }
  return out;
}

export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

export function straightLine(points) {
  if (points.length < 2) return 0;
  const a = points[0], b = points[points.length - 1];
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Shoelace area of the closed figure, in square metres. Sign is dropped — a
 * crew walking a pad anticlockwise still wants a positive number.
 */
export function area(points) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function perimeter(points) {
  if (points.length < 3) return pathLength(points);
  const last = points[points.length - 1], first = points[0];
  return pathLength(points) + Math.hypot(first.x - last.x, first.y - last.y);
}

export function centroid(points) {
  if (!points.length) return null;
  if (points.length < 3) {
    const sx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const sy = points.reduce((s, p) => s + p.y, 0) / points.length;
    return { x: sx, y: sy };
  }
  // Area centroid, not the average of the corners — they differ badly on an
  // L-shaped pad, which is exactly the shape people measure.
  let cx = 0, cy = 0, a2 = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    a2 += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(a2) < 1e-9) {
    return { x: points[0].x, y: points[0].y };
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

/** Does the figure cross itself? A crossed polygon's area is not what it looks. */
export function selfIntersects(points) {
  const n = points.length;
  if (n < 4) return false;
  const seg = i => [points[i], points[(i + 1) % n]];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue; // adjacent
      const [a, b] = seg(i), [c, d] = seg(j);
      if (crosses(a, b, c, d)) return true;
    }
  }
  return false;
}

function crosses(a, b, c, d) {
  const s = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const d1 = s(a, b, c), d2 = s(a, b, d), d3 = s(c, d, a), d4 = s(c, d, b);
  return d1 !== d2 && d3 !== d4;
}

/* ---------------- grade ---------------- */

/**
 * Grade as both a percentage and the run:rise ratio surveyors call out.
 * A 33% grade is "3:1" on a slope stake.
 */
export function formatGrade(grade) {
  if (grade == null || !isFinite(grade)) return '—';
  const pct = grade * 100;
  const text = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  if (Math.abs(grade) < 1e-6) return `${text} · flat`;
  const ratio = Math.abs(1 / grade);
  if (ratio > 99) return text;
  return `${text} · ${ratio.toFixed(ratio < 20 ? 1 : 0)}:1`;
}

/* ---------------- units ---------------- */

export function toDisplay(metres, units) {
  return units === 'ft' ? metres / FOOT : metres;
}

export function formatDistance(metres, units, decimals = 2) {
  if (metres == null || !isFinite(metres)) return '—';
  return `${toDisplay(metres, units).toFixed(decimals)} ${units}`;
}

/**
 * Area in the unit the trade actually uses: square feet with acres alongside,
 * or square metres with hectares. Both, because a pad is quoted in square feet
 * and a parcel in acres, and the same crew wants each on a different day.
 */
export function formatArea(m2, units) {
  if (m2 == null || !isFinite(m2) || m2 <= 0) return { primary: '—', secondary: '' };
  if (units === 'ft') {
    const sqft = m2 / (FOOT * FOOT);
    const acres = m2 / acreMetres2();
    return {
      primary: `${group(sqft, sqft < 100 ? 2 : 0)} ft²`,
      secondary: `${acres.toFixed(acres < 0.1 ? 4 : 3)} acres`,
      sqft, acres
    };
  }
  const ha = m2 / M2_PER_HECTARE;
  return {
    primary: `${group(m2, m2 < 100 ? 2 : 0)} m²`,
    secondary: `${ha.toFixed(ha < 0.1 ? 4 : 3)} ha`,
    m2, ha
  };
}

function group(value, decimals) {
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/* ---------------- summary ---------------- */

/**
 * One object with everything a measurement can tell you, so the UI has no
 * arithmetic left to do.
 */
export function summarise(points, mode, units, decimals = 2) {
  const segs = segments(points);
  const total = pathLength(points);
  const out = {
    mode,
    count: points.length,
    segments: segs,
    total,
    totalText: formatDistance(total, units, decimals),
    straight: straightLine(points),
    straightText: formatDistance(straightLine(points), units, decimals)
  };

  const last = segs[segs.length - 1];
  if (last) {
    out.last = last;
    out.lastText = formatDistance(last.horizontal, units, decimals);
    out.lastGrade = formatGrade(last.grade);
    out.lastSlopeText = last.dz == null ? null : formatDistance(last.slopeDistance, units, decimals);
  }

  // Overall rise and fall along the path, when every point has a height.
  const heights = points.map(p => p.ele).filter(v => v != null);
  if (heights.length === points.length && points.length > 1) {
    const dz = points[points.length - 1].ele - points[0].ele;
    out.dz = dz;
    out.dzText = formatDistance(dz, units, decimals);
    out.grade = total > 0 ? dz / total : null;
    out.gradeText = formatGrade(out.grade);
    out.slopeDistance = segs.reduce((s, x) => s + x.slopeDistance, 0);
    out.slopeDistanceText = formatDistance(out.slopeDistance, units, decimals);
  }

  if (mode === 'area') {
    const a = area(points);
    out.area = a;
    out.areaText = formatArea(a, units);
    out.perimeter = perimeter(points);
    out.perimeterText = formatDistance(out.perimeter, units, decimals);
    out.centroid = centroid(points);
    out.crossed = selfIntersects(points);
  }
  return out;
}
