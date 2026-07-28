// LandXML alignments — the format civil design software actually exports a
// centreline in, complete with its own stationing and station equations.
//
// Geometry elements are densified to a chord tolerance so the polyline
// stationing downstream stays true to the design curve.

import { tags, tag, xml, text_ } from './parse.js';
import { fitSimilarity, applySimilarity } from './geo.js';

// Mid-ordinate error allowed when a curve or spiral is turned into chords.
// 1 mm keeps the cumulative station error to a few thousandths of a foot over
// a mile of alignment, which is well under anything a phone can see anyway.
const CHORD_TOL = 0.001;

export function parseLandXML(text) {
  const doc = xml(text);
  const root = doc.documentElement;
  if (!/LandXML/i.test(root.nodeName)) throw new Error('Not a LandXML file.');

  const linearUnit = readUnits(doc);
  const scale = { meter: 1, foot: 0.3048, usfoot: 1200 / 3937 }[linearUnit] || 1;
  const tol = CHORD_TOL / scale; // work the tolerance back into file units

  const warnings = [];
  const lines = [];

  tags(doc, 'Alignment').forEach((al, i) => {
    const cg = tag(al, 'CoordGeom');
    if (!cg) return;
    const coords = densifyCoordGeom(cg, tol, warnings);
    if (coords.length < 2) return;

    const staStart = num(al.getAttribute('staStart'), 0);
    const equations = tags(al, 'StaEquation').map(eq => ({
      dist: (num(eq.getAttribute('staInternal'), staStart) - staStart), // file units along
      ahead: num(eq.getAttribute('staAhead'), 0),
      back: num(eq.getAttribute('staBack'), null)
    })).filter(e => isFinite(e.dist) && isFinite(e.ahead));

    lines.push({
      id: `AL${i + 1}`,
      name: al.getAttribute('name') || al.getAttribute('desc') || `Alignment ${i + 1}`,
      coords,
      staStart,
      equations,
      declaredLength: num(al.getAttribute('length'), null),
      kind: 'alignment'
    });
  });

  // Anything else with a CoordGeom is still a usable line (feature lines,
  // parcels, edge-of-pavement) — offer them rather than dropping them.
  ['PlanFeature', 'Parcel', 'Boundary'].forEach(nodeName => {
    tags(doc, nodeName).forEach((el, i) => {
      const cg = tag(el, 'CoordGeom');
      if (!cg) return;
      const coords = densifyCoordGeom(cg, tol, warnings);
      if (coords.length > 1) {
        lines.push({ name: el.getAttribute('name') || `${nodeName} ${i + 1}`, coords, kind: 'feature' });
      }
    });
  });

  const points = tags(doc, 'CgPoint').map(p => {
    const c = readPoint(p);
    return c ? { name: p.getAttribute('name') || p.getAttribute('code') || '', x: c[0], y: c[1], desc: p.getAttribute('desc') || '' } : null;
  }).filter(Boolean);

  if (!lines.length) throw new Error('LandXML has no <Alignment> or <CoordGeom> geometry.');

  return { crs: 'grid', linearUnit, lines, points, warnings };
}

function readUnits(doc) {
  const u = tag(doc, 'Units');
  if (!u) return 'meter';
  const metric = tag(u, 'Metric'), imperial = tag(u, 'Imperial');
  const raw = ((imperial || metric || u).getAttribute('linearUnit') || '').toLowerCase();
  if (/ussurvey/.test(raw)) return 'usfoot';
  if (/foot|feet/.test(raw)) return 'foot';
  if (/metre|meter/.test(raw)) return 'meter';
  return imperial ? 'foot' : 'meter';
}

// LandXML point text is "northing easting [elevation]" — Y before X.
function readPoint(el) {
  if (!el) return null;
  const parts = text_(el).split(/[\s,]+/).map(Number).filter(n => isFinite(n));
  if (parts.length < 2) return null;
  return [parts[1], parts[0]]; // -> [easting, northing]
}

function num(v, dflt) {
  if (v == null) return dflt;
  const n = Number(v);
  return isFinite(n) ? n : dflt;
}

function densifyCoordGeom(cg, tol, warnings) {
  const out = [];
  const push = (pts) => {
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
    }
  };

  for (const el of Array.from(cg.children)) {
    const kind = el.localName || el.nodeName.replace(/^.*:/, '');
    if (kind === 'Line') {
      const a = readPoint(tag(el, 'Start')), b = readPoint(tag(el, 'End'));
      if (a && b) push([a, b]);
    } else if (kind === 'Curve') {
      push(densifyCurve(el, tol, warnings));
    } else if (kind === 'Spiral') {
      push(densifySpiral(el, tol, warnings));
    } else if (kind === 'IrregularLine') {
      const start = readPoint(tag(el, 'Start'));
      const end = readPoint(tag(el, 'End'));
      const mids = text_(tag(el, 'PntList2D')).split(/[\s,]+/).map(Number).filter(isFinite);
      const pts = [];
      if (start) pts.push(start);
      for (let i = 0; i + 1 < mids.length; i += 2) pts.push([mids[i + 1], mids[i]]);
      if (end) pts.push(end);
      push(pts);
    }
  }
  return out;
}

function densifyCurve(el, tol, warnings) {
  const start = readPoint(tag(el, 'Start'));
  const end = readPoint(tag(el, 'End'));
  const center = readPoint(tag(el, 'Center'));
  if (!start || !end) return [];
  const R = Math.abs(num(el.getAttribute('radius'), NaN));
  if (!center || !isFinite(R) || R <= 0) {
    warnings.push('A curve was missing its centre or radius and was drawn as a chord.');
    return [start, end];
  }
  const ccw = (el.getAttribute('rot') || '').toLowerCase() !== 'cw';
  let a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  let a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  let sweep = a1 - a0;
  if (ccw) { while (sweep <= 0) sweep += 2 * Math.PI; }
  else { while (sweep >= 0) sweep -= 2 * Math.PI; }

  const rad = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const step = Math.max(0.002, 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / rad))));
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / step));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * (i / n);
    pts.push([center[0] + rad * Math.cos(a), center[1] + rad * Math.sin(a)]);
  }
  pts[pts.length - 1] = end;
  return pts;
}

// Clothoid: integrate the shape in a canonical local frame, then drop it onto
// the real Start/End pair with a two-point similarity. That keeps the spiral
// exact without needing the incoming tangent from the file.
function densifySpiral(el, tol, warnings) {
  const start = readPoint(tag(el, 'Start'));
  const end = readPoint(tag(el, 'End'));
  if (!start || !end) return [];
  const L = num(el.getAttribute('length'), NaN);
  const r1 = radiusAttr(el.getAttribute('radiusStart'));
  const r2 = radiusAttr(el.getAttribute('radiusEnd'));
  const type = (el.getAttribute('spiType') || 'clothoid').toLowerCase();

  if (!isFinite(L) || L <= 0 || type !== 'clothoid') {
    warnings.push('A spiral could not be reconstructed and was drawn as a chord.');
    return [start, end];
  }
  const sign = (el.getAttribute('rot') || '').toLowerCase() === 'cw' ? -1 : 1;
  const k1 = r1 ? 1 / r1 : 0;
  const k2 = r2 ? 1 / r2 : 0;

  const steps = Math.max(24, Math.ceil(L / Math.max(0.25, tol * 20)));
  const ds = L / steps;
  const local = [[0, 0]];
  let th = 0, x = 0, y = 0;
  for (let i = 0; i < steps; i++) {
    const s = i * ds;
    const kA = k1 + (k2 - k1) * (s / L);
    const kB = k1 + (k2 - k1) * ((s + ds) / L);
    const thMid = th + sign * kA * ds / 2;
    x += Math.cos(thMid) * ds;
    y += Math.sin(thMid) * ds;
    th += sign * (kA + kB) / 2 * ds;
    local.push([x, y]);
  }

  const t = fitSimilarity([
    { src: local[0], dst: start },
    { src: local[local.length - 1], dst: end }
  ]);
  if (!t) return [start, end];
  const pts = local.map(p => applySimilarity(t, p[0], p[1]));
  pts[0] = start;
  pts[pts.length - 1] = end;
  return pts;
}

function radiusAttr(v) {
  if (v == null) return 0;
  if (/^inf/i.test(v.trim())) return 0; // infinite radius = tangent
  const n = Number(v);
  return isFinite(n) && n !== 0 ? Math.abs(n) : 0;
}
