// DXF reader — enough of it to pull a centreline out of a plan.
//
// Handles LWPOLYLINE (with bulges), old-style POLYLINE/VERTEX, LINE, ARC and a
// rough SPLINE fallback, from the ENTITIES section. Coordinates come out in
// drawing units, which means grid: georeference before tracking.

const CHORD_TOL = 0.001; // metres of mid-ordinate error allowed on arcs

const INSUNITS = {
  1: 'inch', 2: 'foot', 4: 'mm', 5: 'cm', 6: 'meter', 8: 'micron',
  9: 'mil', 10: 'yard', 21: 'usfoot'
};
const UNIT_TO_LINEAR = { foot: 'foot', usfoot: 'usfoot', meter: 'meter' };

export function parseDXF(text) {
  if (/AutoCAD Binary DXF/.test(text.slice(0, 32))) {
    throw new Error('Binary DXF is not supported. Save as ASCII DXF and try again.');
  }
  const rows = readPairs(text);
  const linearUnit = readInsUnits(rows);
  const warnings = [];
  const entities = collectEntities(rows, warnings);

  const lines = [];
  const points = [];
  let blockRefs = 0;

  for (const e of entities) {
    const layer = str(e, 8) || '0';
    switch (e.type) {
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const coords = polylineCoords(e);
        if (coords.length > 1) lines.push({ name: `${e.type} · ${layer}`, layer, coords });
        break;
      }
      case 'LINE': {
        const a = [n(e, 10), n(e, 20)], b = [n(e, 11), n(e, 21)];
        if (finite(a) && finite(b)) lines.push({ name: `LINE · ${layer}`, layer, coords: [a, b] });
        break;
      }
      case 'ARC': {
        const c = [n(e, 10), n(e, 20)], r = n(e, 40);
        const a0 = n(e, 50) * Math.PI / 180, a1 = n(e, 51) * Math.PI / 180;
        if (finite(c) && isFinite(r) && r > 0) {
          let sweep = a1 - a0;
          while (sweep <= 0) sweep += 2 * Math.PI;
          lines.push({ name: `ARC · ${layer}`, layer, coords: arcPoints(c, r, a0, sweep) });
        }
        break;
      }
      case 'SPLINE': {
        const fit = pairsOf(e, 11, 21);
        const ctrl = pairsOf(e, 10, 20);
        const coords = fit.length > 1 ? fit : ctrl;
        if (coords.length > 1) {
          lines.push({ name: `SPLINE · ${layer}`, layer, coords });
          warnings.push('A SPLINE was approximated by its fit points — check it against the plan before relying on stationing.');
        }
        break;
      }
      case 'POINT': {
        const p = [n(e, 10), n(e, 20)];
        if (finite(p)) points.push({ name: layer, x: p[0], y: p[1], desc: '' });
        break;
      }
      case 'INSERT':
        blockRefs++;
        break;
    }
  }

  if (blockRefs) {
    warnings.push(`${blockRefs} block reference(s) skipped — geometry inside blocks is not read. Explode the alignment if it is missing.`);
  }
  if (!lines.length) throw new Error('No polylines, lines or arcs found in the DXF ENTITIES section.');

  // Longest first: the centreline is nearly always the longest thing drawn.
  lines.sort((a, b) => length(b.coords) - length(a.coords));

  return {
    crs: 'grid',
    linearUnit: UNIT_TO_LINEAR[linearUnit] || null,
    lines, points,
    warnings: [...new Set(warnings)]
  };
}

/* ---------- group-code plumbing ---------- */

function readPairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) { i--; continue; } // resync on a stray line
    out.push([code, lines[i + 1]]);
  }
  return out;
}

function readInsUnits(rows) {
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i][0] === 9 && rows[i][1].trim() === '$INSUNITS') {
      const v = parseInt((rows[i + 1] || [])[1], 10);
      return INSUNITS[v] || null;
    }
  }
  return null;
}

function collectEntities(rows, warnings) {
  const entities = [];
  let section = null, cur = null, polyline = null;

  const close = () => {
    if (!cur) return;
    if (cur.type === 'VERTEX' && polyline) polyline.vertices.push(cur);
    else if (cur.type === 'SEQEND') { polyline = null; }
    else entities.push(cur);
    cur = null;
  };

  for (const [code, rawVal] of rows) {
    const val = rawVal.trim();
    if (code === 0) {
      close();
      if (val === 'SECTION') { cur = null; section = 'pending'; continue; }
      if (val === 'ENDSEC') { section = null; continue; }
      if (section !== 'ENTITIES') { if (val === 'EOF') break; continue; }
      cur = { type: val, groups: [], vertices: [] };
      if (val === 'POLYLINE') polyline = cur;
      continue;
    }
    if (section === 'pending' && code === 2) { section = val.toUpperCase(); continue; }
    if (section !== 'ENTITIES' || !cur) continue;
    cur.groups.push([code, val]);
  }
  close();
  if (!entities.length) warnings.push('The DXF ENTITIES section was empty.');
  return entities;
}

const str = (e, code) => { const g = e.groups.find(g => g[0] === code); return g ? g[1] : null; };
const n = (e, code) => { const g = e.groups.find(g => g[0] === code); return g ? Number(g[1]) : NaN; };
const finite = (p) => p.every(v => isFinite(v));

function pairsOf(e, xc, yc) {
  const xs = e.groups.filter(g => g[0] === xc).map(g => Number(g[1]));
  const ys = e.groups.filter(g => g[0] === yc).map(g => Number(g[1]));
  const out = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (isFinite(xs[i]) && isFinite(ys[i])) out.push([xs[i], ys[i]]);
  }
  return out;
}

/* ---------- geometry ---------- */

function polylineCoords(e) {
  const verts = [];
  if (e.type === 'LWPOLYLINE') {
    // Walk the groups in order so each bulge stays attached to its vertex.
    let cx = null, cy = null, bulge = 0, seen = false;
    const flush = () => { if (seen) verts.push({ x: cx, y: cy, bulge }); };
    for (const [code, v] of e.groups) {
      if (code === 10) { flush(); cx = Number(v); cy = NaN; bulge = 0; seen = true; }
      else if (code === 20) cy = Number(v);
      else if (code === 42) bulge = Number(v);
    }
    flush();
  } else {
    for (const vtx of e.vertices) {
      verts.push({ x: n(vtx, 10), y: n(vtx, 20), bulge: isFinite(n(vtx, 42)) ? n(vtx, 42) : 0 });
    }
  }
  const closed = (n(e, 70) & 1) === 1;
  const clean = verts.filter(v => isFinite(v.x) && isFinite(v.y));
  if (closed && clean.length > 2) clean.push({ ...clean[0], bulge: 0 });

  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i], b = clean[i + 1];
    if (!b) { out.push([a.x, a.y]); break; }
    if (a.bulge) out.push(...bulgeArc([a.x, a.y], [b.x, b.y], a.bulge));
    else out.push([a.x, a.y]);
  }
  return dedupe(out);
}

// DXF bulge = tan(included angle / 4); positive is counter-clockwise.
function bulgeArc(p1, p2, bulge) {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const c = Math.hypot(dx, dy);
  if (!c) return [p1];
  const theta = 4 * Math.atan(bulge);
  const R = c / (2 * Math.sin(theta / 2));
  const d = R * Math.cos(theta / 2);
  const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const cen = [mid[0] - dy / c * d, mid[1] + dx / c * d];
  const a0 = Math.atan2(p1[1] - cen[1], p1[0] - cen[0]);
  return arcPoints(cen, Math.abs(R), a0, theta).slice(0, -1);
}

function arcPoints(cen, r, a0, sweep) {
  const step = Math.max(0.002, 2 * Math.acos(Math.max(-1, Math.min(1, 1 - CHORD_TOL / r))));
  const count = Math.max(2, Math.ceil(Math.abs(sweep) / step));
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const a = a0 + sweep * (i / count);
    pts.push([cen[0] + r * Math.cos(a), cen[1] + r * Math.sin(a)]);
  }
  return pts;
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
  }
  return out;
}

function length(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}
