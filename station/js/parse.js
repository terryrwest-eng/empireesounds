// File readers. The job of every parser here is the same: hand back a set of
// candidate lines (plus any stray points) in whatever coordinate system the
// file uses, and say which system that is.
//
//   crs 'geographic' -> coords are [lon, lat]
//   crs 'grid'       -> coords are [easting, northing] in `linearUnit`
//
// Grid files get georeferenced later against control points; geographic files
// are ready to use as-is.

import { parseLandXML } from './landxml.js';
import { parseDXF } from './dxf.js';
import { polylineLength } from './alignment.js';

export const XML_NS = '*';
export function tags(el, name) { return Array.from(el.getElementsByTagNameNS(XML_NS, name)); }
export function tag(el, name) { return el.getElementsByTagNameNS(XML_NS, name)[0] || null; }

export async function parseFile(file) {
  const name = file.name || 'alignment';
  const ext = (name.split('.').pop() || '').toLowerCase();

  if (ext === 'kmz' || ext === 'zip') {
    const kml = await readKmzText(await file.arrayBuffer());
    return finish(parseKML(kml), name, 'KMZ');
  }

  const text = await file.text();
  switch (ext) {
    case 'geojson':
    case 'json':  return finish(parseGeoJSON(text), name, 'GeoJSON');
    case 'gpx':   return finish(parseGPX(text), name, 'GPX');
    case 'kml':   return finish(parseKML(text), name, 'KML');
    case 'csv':
    case 'txt':
    case 'pnt':   return finish(parseCSV(text), name, 'CSV');
    case 'dxf':   return finish(parseDXF(text), name, 'DXF');
    case 'xml':
    case 'landxml': return finish(parseLandXML(text), name, 'LandXML');
    default: {
      // No usable extension — sniff the content instead.
      const head = text.slice(0, 4096);
      if (/<LandXML/i.test(head)) return finish(parseLandXML(text), name, 'LandXML');
      if (/<gpx/i.test(head)) return finish(parseGPX(text), name, 'GPX');
      if (/<kml/i.test(head)) return finish(parseKML(text), name, 'KML');
      if (/^\s*[{[]/.test(head)) return finish(parseGeoJSON(text), name, 'GeoJSON');
      if (/^\s*0\s*[\r\n]+\s*SECTION/i.test(head)) return finish(parseDXF(text), name, 'DXF');
      return finish(parseCSV(text), name, 'CSV');
    }
  }
}

function finish(result, fileName, source) {
  const out = {
    source,
    fileName,
    crs: result.crs,
    linearUnit: result.linearUnit || null,
    lines: (result.lines || []).filter(l => l.coords && l.coords.length > 1),
    points: result.points || [],
    warnings: result.warnings || []
  };
  out.lines.forEach((l, i) => {
    l.id = l.id || `L${i + 1}`;
    l.name = l.name || `Line ${i + 1}`;
    l.rawLength = polylineLength(l.coords); // file units / degrees — display later
  });
  if (!out.lines.length) {
    throw new Error(`No line geometry found in ${fileName}. The file needs at least one polyline, track, or alignment.`);
  }
  return out;
}

/* ---------------- GeoJSON ---------------- */

export function parseGeoJSON(text) {
  const gj = JSON.parse(text);
  const lines = [], points = [];
  const walk = (node, inheritedName) => {
    if (!node) return;
    if (node.type === 'FeatureCollection') return node.features.forEach(f => walk(f, inheritedName));
    if (node.type === 'GeometryCollection') return node.geometries.forEach(g => walk(g, inheritedName));
    if (node.type === 'Feature') {
      const p = node.properties || {};
      const nm = p.name || p.Name || p.NAME || p.title || p.desc || inheritedName;
      const g = node.geometry;
      if (g) walk({ ...g, __name: nm, __props: p }, nm);
      return;
    }
    const nm = node.__name || inheritedName;
    const props = node.__props || {};
    if (node.type === 'LineString') {
      lines.push({ name: nm, coords: node.coordinates.map(c => [c[0], c[1]]), meta: props });
    } else if (node.type === 'MultiLineString') {
      node.coordinates.forEach((part, i) =>
        lines.push({ name: nm ? `${nm} (${i + 1})` : null, coords: part.map(c => [c[0], c[1]]), meta: props }));
    } else if (node.type === 'Point') {
      points.push({ name: nm, x: node.coordinates[0], y: node.coordinates[1], desc: props.description || '' });
    } else if (node.type === 'Polygon') {
      node.coordinates.forEach((ring, i) =>
        lines.push({ name: nm ? `${nm} (ring ${i + 1})` : null, coords: ring.map(c => [c[0], c[1]]), meta: props }));
    }
  };
  walk(gj);
  return { crs: 'geographic', lines, points };
}

/* ---------------- GPX ---------------- */

export function parseGPX(text) {
  const doc = xml(text);
  const lines = [], points = [];
  const grab = (el) => [Number(el.getAttribute('lon')), Number(el.getAttribute('lat'))];

  tags(doc, 'trk').forEach((trk, ti) => {
    const nm = text_(tag(trk, 'name')) || `Track ${ti + 1}`;
    const segs = tags(trk, 'trkseg');
    segs.forEach((seg, si) => {
      const coords = tags(seg, 'trkpt').map(grab);
      lines.push({ name: segs.length > 1 ? `${nm} · seg ${si + 1}` : nm, coords });
    });
  });
  tags(doc, 'rte').forEach((rte, ri) => {
    lines.push({ name: text_(tag(rte, 'name')) || `Route ${ri + 1}`, coords: tags(rte, 'rtept').map(grab) });
  });
  tags(doc, 'wpt').forEach(w => {
    const [x, y] = grab(w);
    points.push({ name: text_(tag(w, 'name')) || 'WPT', x, y, desc: text_(tag(w, 'desc')) || '' });
  });
  return { crs: 'geographic', lines, points };
}

/* ---------------- KML / KMZ ---------------- */

export function parseKML(text) {
  const doc = xml(text);
  const lines = [], points = [];
  const parseCoords = (el) => (el.textContent || '').trim().split(/\s+/).filter(Boolean)
    .map(t => t.split(',').map(Number)).filter(c => c.length >= 2 && isFinite(c[0]) && isFinite(c[1]))
    .map(c => [c[0], c[1]]);

  tags(doc, 'Placemark').forEach((pm, i) => {
    const nm = text_(tag(pm, 'name')) || `Placemark ${i + 1}`;
    const desc = text_(tag(pm, 'description')) || '';
    tags(pm, 'LineString').forEach((ls, j, arr) => {
      const c = parseCoords(tag(ls, 'coordinates'));
      lines.push({ name: arr.length > 1 ? `${nm} (${j + 1})` : nm, coords: c });
    });
    tags(pm, 'LinearRing').forEach((lr, j) => {
      lines.push({ name: `${nm} (ring ${j + 1})`, coords: parseCoords(tag(lr, 'coordinates')) });
    });
    tags(pm, 'Point').forEach(pt => {
      const c = parseCoords(tag(pt, 'coordinates'))[0];
      if (c) points.push({ name: nm, x: c[0], y: c[1], desc });
    });
  });
  return { crs: 'geographic', lines, points };
}

// Minimal ZIP reader — enough to pull doc.kml out of a KMZ. Deflate goes
// through DecompressionStream so there's no library to ship.
export async function readKmzText(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a readable KMZ (no zip directory).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const pick = entries.find(e => /^doc\.kml$/i.test(e.name)) || entries.find(e => /\.kml$/i.test(e.name));
  if (!pick) throw new Error('No .kml inside the KMZ.');

  const lhNameLen = dv.getUint16(pick.local + 26, true);
  const lhExtraLen = dv.getUint16(pick.local + 28, true);
  const start = pick.local + 30 + lhNameLen + lhExtraLen;
  const raw = u8.subarray(start, start + pick.compSize);
  if (pick.method === 0) return dec.decode(raw);
  if (pick.method !== 8) throw new Error(`Unsupported KMZ compression (method ${pick.method}).`);
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip KMZ. Unzip it and load the .kml.');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

/* ---------------- CSV / point files ---------------- */

const LAT_KEYS = ['lat', 'latitude', 'y_lat'];
const LON_KEYS = ['lon', 'lng', 'long', 'longitude', 'x_lon'];
const N_KEYS = ['n', 'north', 'northing', 'y'];
const E_KEYS = ['e', 'east', 'easting', 'x'];
const STA_KEYS = ['sta', 'station', 'chainage'];
const DESC_KEYS = ['desc', 'description', 'name', 'code', 'note', 'pt', 'point', 'id'];

export function parseCSV(text) {
  const rows = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
  if (!rows.length) throw new Error('Empty file.');
  const delim = sniffDelim(rows[0]);
  const cells = rows.map(r => splitRow(r, delim));

  const header = cells[0].map(c => c.toLowerCase().replace(/[^a-z_]/g, ''));
  const hasHeader = header.some(h => [...LAT_KEYS, ...LON_KEYS, ...N_KEYS, ...E_KEYS, ...STA_KEYS].includes(h));
  const body = hasHeader ? cells.slice(1) : cells;

  let latI = -1, lonI = -1, nI = -1, eI = -1, staI = -1, descI = -1;
  if (hasHeader) {
    header.forEach((h, i) => {
      if (latI < 0 && LAT_KEYS.includes(h)) latI = i;
      if (lonI < 0 && LON_KEYS.includes(h)) lonI = i;
      if (nI < 0 && N_KEYS.includes(h)) nI = i;
      if (eI < 0 && E_KEYS.includes(h)) eI = i;
      if (staI < 0 && STA_KEYS.includes(h)) staI = i;
      if (descI < 0 && DESC_KEYS.includes(h)) descI = i;
    });
  } else {
    // Headerless. Either "lat,lon[,...]" or surveyor PNEZD (pt,north,east,elev,desc).
    const first = body[0].map(Number);
    const looksLatLon = Math.abs(first[0]) <= 90 && Math.abs(first[1]) <= 180 &&
      (Math.abs(first[0]) > 0.0001 || Math.abs(first[1]) > 0.0001) &&
      !(Number.isInteger(first[0]) && body[0].length >= 5);
    if (looksLatLon) { latI = 0; lonI = 1; descI = body[0].length > 2 ? 2 : -1; }
    else { nI = 1; eI = 2; descI = 4; }
  }

  const geographic = latI >= 0 && lonI >= 0;
  if (!geographic && (nI < 0 || eI < 0)) {
    throw new Error('Could not find coordinates. Use headers like lat,lon or northing,easting — or a PNEZD point file.');
  }

  const coords = [], points = [];
  let staStart = null;
  body.forEach((c, idx) => {
    const a = Number(c[geographic ? latI : nI]);
    const b = Number(c[geographic ? lonI : eI]);
    if (!isFinite(a) || !isFinite(b)) return;
    const xy = geographic ? [b, a] : [b, a]; // [lon,lat] or [east,north]
    coords.push(xy);
    const label = descI >= 0 ? (c[descI] || '') : '';
    points.push({ name: label || `P${idx + 1}`, x: xy[0], y: xy[1], desc: label });
    if (staI >= 0 && staStart === null) {
      const s = Number(String(c[staI]).replace('+', ''));
      if (isFinite(s)) staStart = s;
    }
  });
  if (coords.length < 2) throw new Error('Need at least two coordinate rows to build a centreline.');

  return {
    crs: geographic ? 'geographic' : 'grid',
    lines: [{ name: 'Centreline from points', coords, staStart }],
    points,
    warnings: geographic ? [] : ['Northing/easting file — georeference it before GPS tracking.']
  };
}

function sniffDelim(row) {
  const counts = [[',', (row.match(/,/g) || []).length], ['\t', (row.match(/\t/g) || []).length],
                  [';', (row.match(/;/g) || []).length], [/\s+/, (row.match(/\s+/g) || []).length]];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ',';
}

function splitRow(row, delim) {
  if (delim instanceof RegExp) return row.split(delim);
  const out = []; let cur = '', q = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (q) {
      if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/* ---------------- shared xml helpers ---------------- */

export function xml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('Malformed XML: ' + (err.textContent || '').slice(0, 120));
  return doc;
}

export function text_(el) { return el ? (el.textContent || '').trim() : ''; }
