// Station — wiring. Load an alignment, watch the GPS, print where you are.

import { LocalFrame, fitSimilarity, applySimilarity, azimuth, quadrantBearing, M_PER_INTL_FT, M_PER_US_FT } from './geo.js';
import { Alignment, formatStation, parseStation, formatOffset, simplify, polylineLength } from './alignment.js';
import { parseFile } from './parse.js';
import { PlanView } from './map.js';
import { RoverLink, support } from './rover.js';
import { NmeaReader, buildGGA } from './nmea.js';
import { NtripClient, casterDistanceKm } from './ntrip.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'station.project.v1';
const SETTINGS_KEY = 'station.settings.v1';
const MAX_STORE = 3_500_000;

const UNIT_M = { meter: 1, foot: M_PER_INTL_FT, usfoot: M_PER_US_FT };

const state = {
  file: null,          // parse result
  lineId: null,
  units: 'ft',         // display system for geographic files; forced by the file for grid files
  interval: 100,
  decimals: 2,
  staStart: 0,
  equations: [],       // [{along (display units), ahead}]
  control: [],         // [{src:[e,n], lat, lon, label}]
  transform: null,
  frame: null,
  alignment: null,
  marks: [],
  target: null,
  smooth: true,
  demo: false,
  source: 'phone',     // 'phone' | 'rover'
  baud: 38400,
  antenna: 0,          // rod height, in display units
  ntrip: { host: '', port: 2101, mount: '', user: '', pass: '', tls: false, remember: false }
};

let view = null;
let watchId = null;
let wakeLock = null;
let lastFix = null;      // {x,y,acc,heading,speed,lat,lon,ele,t}
let smoothed = null;
let demoTimer = null;
let demoDist = 0;
let ctrlSrcMode = 'sta';

/* ─────────────────────────── units ─────────────────────────── */

function unitLabel() {
  if (state.file && state.file.crs === 'grid') {
    return (state.file.linearUnit || 'meter') === 'meter' ? 'm' : 'ft';
  }
  return state.units;
}
function metresPerFileUnit() {
  return UNIT_M[state.file?.linearUnit] ?? 1;
}
function unitsPerMetre() {
  if (!state.file) return 1;
  if (state.file.crs === 'grid') {
    // Grid stationing is measured in the file's own units along the file's own
    // geometry, so derive it from the fitted scale rather than a nominal factor.
    return state.transform ? 1 / state.transform.scale : 1;
  }
  return state.units === 'ft' ? 1 / M_PER_INTL_FT : 1;
}

/* ─────────────────────── build the alignment ─────────────────────── */

function currentLine() {
  if (!state.file) return null;
  return state.file.lines.find(l => l.id === state.lineId) || state.file.lines[0] || null;
}

function build() {
  const line = currentLine();
  if (!line) { state.alignment = null; return; }
  const upm = unitsPerMetre();
  let xy, frame = null;

  if (state.file.crs === 'geographic') {
    const mid = line.coords[Math.floor(line.coords.length / 2)];
    frame = new LocalFrame(mid[1], mid[0]);
    xy = line.coords.map(([lon, lat]) => frame.toXY(lat, lon));
  } else if (state.transform) {
    frame = state.frame;
    xy = line.coords.map(([e, n]) => applySimilarity(state.transform, e, n));
  } else {
    // Not georeferenced yet — draw it in raw grid units so the plan and the
    // stationing still work; GPS stays disabled until control goes in.
    xy = line.coords.map(c => [c[0], c[1]]);
  }

  state.frame = frame;
  smoothed = null; // the filter's history belongs to the old frame
  state.alignment = new Alignment(simplify(xy, 0.0005), {
    name: line.name,
    staStart: state.staStart,
    unitsPerMetre: upm,
    equations: state.equations.map(e => ({ dist: e.along / upm, ahead: e.ahead }))
  });

  view.setAlignment(state.alignment, { label: unitLabel(), perMetre: upm, interval: state.interval });
  view.pois = pois();
  refreshMarkXY();
  renderAll();
}

function pois() {
  if (!state.file) return [];
  const pts = state.file.points || [];
  if (!pts.length) return [];
  if (state.file.crs === 'geographic') {
    if (!state.frame) return [];
    return pts.slice(0, 2000).map(p => {
      const [x, y] = state.frame.toXY(p.y, p.x);
      return { x, y, name: p.name };
    });
  }
  return pts.slice(0, 2000).map(p => {
    const [x, y] = state.transform ? applySimilarity(state.transform, p.x, p.y) : [p.x, p.y];
    return { x, y, name: p.name };
  });
}

/* ─────────────────────────── file loading ─────────────────────────── */

async function loadFile(file) {
  const msg = $('fileMsg');
  msg.hidden = false;
  msg.className = 'msg';
  msg.textContent = `Reading ${file.name}…`;
  try {
    const parsed = await parseFile(file);
    state.file = parsed;
    state.lineId = parsed.lines[0].id;
    state.control = [];
    state.transform = null;
    state.frame = null;
    state.target = null;
    $('targetSta').value = '';

    const line = parsed.lines[0];
    state.staStart = line.staStart ?? 0;
    state.equations = (line.equations || []).map(e => ({ along: e.dist, ahead: e.ahead }));

    if (parsed.crs === 'grid') {
      state.units = (parsed.linearUnit || 'meter') === 'meter' ? 'm' : 'ft';
    }
    state.interval = state.units === 'm' ? 1000 : 100;

    const bits = [`${parsed.source} · ${parsed.lines.length} line${parsed.lines.length > 1 ? 's' : ''}`];
    if (parsed.crs === 'grid') bits.push(`grid coordinates (${parsed.linearUnit || 'units unknown'})`);
    else bits.push('latitude / longitude');
    msg.className = 'msg ok';
    msg.textContent = bits.join(' · ');
    if (parsed.warnings.length) {
      msg.className = 'msg warn';
      msg.textContent += ' — ' + parsed.warnings.join(' ');
    }

    syncSettingsInputs();
    build();
    save();
    renderProjectTab();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message || String(err);
    console.error(err);
  }
}

/* ─────────────────────────── position sources ─────────────────────────── */

function startGps() {
  if (state.source === 'rover') {
    // The receiver is the position source; the button just re-opens the link.
    if (!rover.connected) { showTab('rover'); flash($('roverMsg'), 'warn', 'Connect the receiver first.'); }
    return;
  }
  if (!navigator.geolocation) return setPill('bad', 'No GPS');
  if (watchId != null) return;
  setPill('warn', 'Acquiring…');
  watchId = navigator.geolocation.watchPosition(onPhoneFix, onGpsError, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 30000
  });
  setTracking(true);
  requestWake();
}

function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  smoothed = null;
  setTracking(false);
  setPill('', 'GPS off');
  releaseWake();
  if (!state.demo) { lastFix = null; view.fix = null; view.snap = null; renderAll(); }
}

function setTracking(on) {
  $('btnGps').textContent = on ? 'Stop GPS' : 'Start GPS';
  $('btnGps').classList.toggle('on', on);
}

function tracking() { return watchId != null || (state.source === 'rover' && rover.connected); }

function onGpsError(err) {
  const map = {
    1: 'Location permission denied — allow it in the browser settings.',
    2: 'Position unavailable. Step into the open and try again.',
    3: 'GPS timed out.'
  };
  setPill('bad', 'GPS error');
  const w = $('staWarn');
  w.hidden = false;
  w.textContent = map[err.code] || err.message;
}

function onPhoneFix(pos) {
  const c = pos.coords;
  applyFix({
    lat: c.latitude, lon: c.longitude, acc: c.accuracy,
    heading: (c.speed != null && c.speed > 0.6) ? c.heading : null,
    speed: c.speed, ele: c.altitude, t: pos.timestamp,
    q: { source: 'phone', label: 'PHONE GPS', rank: 1 }
  });
}

/**
 * The one road every position takes, wherever it came from: phone, rover or
 * the demo walk. Projects into the local frame, filters, renders.
 */
function applyFix(fix) {
  const label = fix.q?.label || 'GPS';
  setPill(pillClass(fix), fix.acc != null ? `${label} ±${fmtAcc(fix.acc)}` : label);

  if (!state.frame) {
    lastFix = fix;
    $('staWarn').hidden = false;
    $('staWarn').textContent = state.file
      ? 'Georeference the alignment (Project tab) before it can be tracked.'
      : 'Load an alignment on the Project tab.';
    renderReadout(); renderTiles();
    return;
  }

  const [rx, ry] = state.frame.toXY(fix.lat, fix.lon);
  // An RTK fixed solution is already centimetres; filtering it only adds lag.
  const filter = state.smooth && !(fix.q && fix.q.rank >= 5);
  if (filter) {
    // Drop the history on a gap or a jump — a filter that lags reality by
    // 70 metres is worse than no filter at all.
    const gap = lastFix ? fix.t - lastFix.t : 0;
    const acc = fix.acc ?? 5;
    if (smoothed && (gap > 10000 || Math.hypot(rx - smoothed[0], ry - smoothed[1]) > Math.max(25, acc * 4))) {
      smoothed = null;
    }
    const a = Math.max(0.15, Math.min(0.85, 6 / Math.max(1, acc)));
    smoothed = smoothed ? [smoothed[0] + (rx - smoothed[0]) * a, smoothed[1] + (ry - smoothed[1]) * a] : [rx, ry];
  } else {
    smoothed = [rx, ry];
  }
  fix.x = smoothed[0]; fix.y = smoothed[1];
  lastFix = fix;
  view.fix = fix;
  renderAll();
}

function pillClass(fix) {
  if (fix.q?.rank >= 5) return 'on';
  if (fix.q?.rank === 4) return 'warn';
  if (fix.acc == null) return 'warn';
  return fix.acc <= 8 ? 'on' : fix.acc <= 20 ? 'warn' : 'bad';
}

// Centimetre accuracies deserve centimetres; a phone's ±14 m does not.
const fmtAcc = m => (m == null || !isFinite(m)) ? '—' : (m < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(1)} m`);

async function requestWake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not fatal */ }
}
function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId != null && !wakeLock) requestWake();
});

/* ─────────────────────────── external receiver ─────────────────────────── */

let lastRoverFix = null;   // the raw NMEA fix, kept for the GGA the caster wants

const rover = new RoverLink({
  onData: chunk => nmea.push(chunk),
  onStatus: s => onRoverStatus(s)
});

const nmea = new NmeaReader(fix => onRoverFix(fix));

const ntrip = new NtripClient({
  onRtcm: bytes => { if (rover.connected) rover.write(bytes); },
  onStatus: s => onNtripStatus(s),
  onStats: () => scheduleNtripStats()
});

function onRoverFix(fix) {
  lastRoverFix = fix;
  $('roverStats').hidden = false;
  renderRoverStats();
  if (state.source !== 'rover') return;
  if (!fix.valid) {
    setPill('bad', fix.meta ? fix.meta.label : 'NO FIX');
    return;
  }
  const ele = fix.alt != null ? fix.alt - antennaMetres() : null;
  applyFix({
    lat: fix.lat, lon: fix.lon,
    acc: fix.accuracy,
    heading: (fix.speed != null && fix.speed > 0.6) ? fix.course : null,
    speed: fix.speed,
    ele,
    t: Date.now(),
    q: {
      source: 'rover', label: fix.qualityLabel, rank: fix.meta.rank, quality: fix.quality,
      sats: fix.sats, hdop: fix.hdop, pdop: fix.pdop,
      sigmaH: fix.sigmaH, sigmaV: fix.sigmaV,
      ageOfDiff: fix.ageOfDiff, baseId: fix.baseId,
      ellipsoidAlt: fix.ellipsoidAlt, antenna: antennaMetres()
    }
  });
}

function antennaMetres() {
  const v = Number(state.antenna) || 0;
  return unitLabel() === 'ft' ? v * M_PER_INTL_FT : v;
}

function onRoverStatus(s) {
  const msg = $('roverMsg');
  if (s.state === 'connected') {
    flash(msg, 'ok', `Connected to ${s.detail}. Waiting for NMEA…`);
    $('btnDisconnect').hidden = false;
    $('roverStats').hidden = false;
    setTracking(true);
    requestWake();
  } else if (s.state === 'connecting') {
    flash(msg, '', `Opening ${s.detail}…`);
  } else if (s.state === 'lost') {
    flash(msg, 'err', `Receiver disconnected: ${s.detail}`);
    $('btnDisconnect').hidden = true;
    setTracking(false);
    setPill('bad', 'Rover lost');
  } else if (s.state === 'error') {
    flash(msg, 'err', s.detail);
  }
  renderRoverStats();
}

async function connectRover(kind) {
  const msg = $('roverMsg');
  try {
    if (state.source !== 'rover') setSource('rover');
    await rover.connect(kind, { baudRate: Number(state.baud) });
  } catch (err) {
    // A cancelled chooser is not an error worth shouting about.
    if (/cancel|no device selected|user gesture/i.test(err.message || '')) { flash(msg, '', 'No device chosen.'); return; }
    flash(msg, 'err', err.message || String(err));
  }
}

async function disconnectRover() {
  await rover.disconnect();
  $('btnDisconnect').hidden = true;
  lastRoverFix = null;
  setTracking(false);
  setPill('', 'GPS off');
  releaseWake();
  flash($('roverMsg'), '', 'Receiver disconnected.');
  renderRoverStats();
}

function setSource(source) {
  const wasLive = tracking();
  const changed = state.source !== source;
  state.source = source;
  if (changed) {
    // A position from the old source is history, not a reading. Clear it so the
    // readout cannot show a stale station as though it were live.
    lastFix = null; smoothed = null;
    view.fix = null; view.snap = null;
    state.lastProjection = null;
  }
  document.querySelectorAll('#srcSeg .seg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.source === source));
  $('roverBlock').hidden = source !== 'rover';
  if (source === 'rover') {
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    setTracking(rover.connected);
    const missing = [];
    if (!support.usb) missing.push('USB');
    if (!support.ble) missing.push('Bluetooth');
    if (!support.serial) missing.push('serial ports');
    $('sourceNote').textContent = missing.length === 3
      ? 'This browser cannot reach an external receiver at all. On iOS that is a platform limit, not a setting — Safari and every iOS browser lack WebUSB and Web Bluetooth.'
      : missing.length
        ? `This browser supports ${['USB', 'Bluetooth', 'serial ports'].filter(x => !missing.includes(x)).join(' and ')}. Not available here: ${missing.join(', ')}.`
        : 'USB, Bluetooth and serial are all available in this browser.';
    ['btnUsb', 'btnBle', 'btnSerial'].forEach((id, i) => { $(id).disabled = ![support.usb, support.ble, support.serial][i]; });
  } else {
    $('sourceNote').textContent = 'The phone\'s own GPS. Metres, not centimetres — fine for finding a station, not for setting one.';
    setTracking(watchId != null);
    if (changed && wasLive) startGps(); // keep tracking across the switch
  }
  smoothed = null;
  if (changed) renderAll();
  save();
}

/* ─────────────────────────── NTRIP ─────────────────────────── */

function ntripOpts() {
  const n = state.ntrip;
  return {
    host: n.host.trim(), port: Number(n.port) || 2101, mount: n.mount.trim(),
    user: n.user, pass: n.pass, tls: !!n.tls,
    // VRS and nearest-base mountpoints need to know where the rover is.
    gga: () => (lastRoverFix && lastRoverFix.valid ? buildGGA(lastRoverFix) : '')
  };
}

async function fetchMountpoints() {
  const msg = $('ntripMsg');
  readNtripInputs();
  if (!state.ntrip.host) return flash(msg, 'err', 'Enter the caster host first.');
  flash(msg, '', 'Asking the caster for its mountpoint list…');
  try {
    const list = await ntrip.sourcetable(ntripOpts());
    if (!list.length) return flash(msg, 'warn', 'The caster answered, but its table has no mountpoints.');
    const here = lastRoverFix?.valid ? lastRoverFix : lastFix;
    list.forEach(e => { e.km = here ? casterDistanceKm(e, here.lat, here.lon) : null; });
    if (here) list.sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
    renderMountpoints(list);
    flash(msg, 'ok', `${list.length} mountpoints${here ? ', nearest first' : ''}.`);
  } catch (err) {
    flash(msg, 'err', err.message || String(err));
  }
}

function renderMountpoints(list) {
  const wrap = $('mountTable');
  const datalist = $('mountList');
  wrap.innerHTML = '';
  datalist.innerHTML = '';
  list.slice(0, 60).forEach(e => {
    datalist.append(Object.assign(document.createElement('option'), { value: e.mount }));
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'linerow' + (e.mount === state.ntrip.mount ? ' is-on' : '');
    const main = document.createElement('div');
    main.className = 'linerow-main';
    const nm = document.createElement('div');
    nm.className = 'linerow-name';
    nm.textContent = e.mount;
    const sub = document.createElement('div');
    sub.className = 'linerow-sub';
    sub.textContent = [
      e.format, e.km != null ? `${e.km.toFixed(1)} km` : null,
      e.needsGga ? 'VRS (sends GGA)' : null, e.needsAuth ? 'login' : null, e.identifier
    ].filter(Boolean).join(' · ');
    main.append(nm, sub);
    row.append(main);
    row.onclick = () => {
      state.ntrip.mount = e.mount;
      $('ntMount').value = e.mount;
      renderMountpoints(list);
      save();
    };
    wrap.append(row);
  });
}

function toggleNtrip() {
  const msg = $('ntripMsg');
  if (ntrip.wanted) { ntrip.disconnect(); return; }
  readNtripInputs();
  if (!state.ntrip.host || !state.ntrip.mount) return flash(msg, 'err', 'A caster host and a mountpoint are both needed.');
  if (!rover.connected) flash(msg, 'warn', 'Corrections will be pulled, but nothing is connected to send them to yet.');
  $('ntripStats').hidden = false;
  ntrip.connect(ntripOpts());
  save();
}

function onNtripStatus(s) {
  const msg = $('ntripMsg');
  const el = $('nState');
  $('btnNtrip').textContent = ntrip.wanted ? 'Stop corrections' : 'Connect corrections';
  $('btnNtrip').classList.toggle('on', ntrip.wanted);
  if (s.state === 'on') { el.textContent = `streaming ${s.mount}`; el.className = 'stat-v good'; flash(msg, 'ok', `Corrections streaming from ${s.mount}.`); }
  else if (s.state === 'connecting') { el.textContent = 'connecting'; el.className = 'stat-v warn'; }
  else if (s.state === 'retrying') {
    el.textContent = 'retrying'; el.className = 'stat-v warn';
    flash(msg, 'warn', `${s.detail} Retrying in ${Math.round(s.inMs / 1000)}s.`);
  } else { el.textContent = 'off'; el.className = 'stat-v'; }
  renderNtripStats();
}

let ntripStatsTimer = null;
function scheduleNtripStats() {
  if (ntripStatsTimer) return;
  ntripStatsTimer = setTimeout(() => { ntripStatsTimer = null; renderNtripStats(); }, 500);
}

function renderNtripStats() {
  const s = ntrip.stats();
  $('nBytes').textContent = s.bytes ? formatBytes(s.bytes) : '—';
  const age = s.ageMs == null ? null : s.ageMs / 1000;
  $('nAge').textContent = age == null ? '—' : `${age.toFixed(0)} s ago`;
  $('nAge').className = 'stat-v' + (age == null ? '' : age < 5 ? ' good' : age < 30 ? ' warn' : ' bad');
  $('nTypes').textContent = s.types.length ? s.types.map(([t, n]) => `${t}×${n}`).join('  ') : '—';
}

function readNtripInputs() {
  state.ntrip = {
    host: $('ntHost').value.trim(),
    port: Number($('ntPort').value) || 2101,
    mount: $('ntMount').value.trim(),
    user: $('ntUser').value,
    pass: $('ntPass').value,
    tls: $('ntTls').checked,
    remember: $('ntRemember').checked
  };
}

function renderRoverStats() {
  const f = lastRoverFix;
  const wrap = $('roverStats');
  if (!wrap || wrap.hidden) return;
  const q = f && f.valid ? f : null;
  const set = (id, text, cls = '') => { const el = $(id); el.textContent = text; el.className = 'stat-v' + (cls ? ' ' + cls : ''); };

  const label = f ? (f.qualityLabel || f.meta?.label || 'NO FIX') : (rover.connected ? 'waiting…' : '—');
  set('sQuality', label, !f || !f.valid ? 'bad' : f.meta.rank >= 5 ? 'good' : f.meta.rank >= 4 ? 'warn' : '');
  set('sSigmaH', q?.sigmaH != null ? fmtAcc(q.sigmaH) : '—', q?.sigmaH != null && q.sigmaH < 0.05 ? 'good' : '');
  set('sSigmaV', q?.sigmaV != null ? fmtAcc(q.sigmaV) : '—');
  set('sSats', q?.sats != null ? String(q.sats) : '—');
  set('sDop', q ? `${q.pdop != null ? q.pdop.toFixed(1) : '—'} / ${q.hdop != null ? q.hdop.toFixed(1) : '—'}` : '—');
  const age = q?.ageOfDiff;
  set('sAge', age != null ? `${age.toFixed(1)} s` : '—', age == null ? '' : age < 5 ? 'good' : age < 30 ? 'warn' : 'bad');
  set('sBase', q?.baseId || '—');
  set('sBytes', rover.bytesIn ? `${formatBytes(rover.bytesIn)} in · ${formatBytes(rover.bytesOut)} out` : '—');
  set('sEllip', q?.ellipsoidAlt != null ? `${q.ellipsoidAlt.toFixed(3)} m` : '—');
}

const formatBytes = b =>
  b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b > 1500 ? `${(b / 1e3).toFixed(1)} kB` : `${b} B`;

/* ─────────────────────────── demo walk ─────────────────────────── */

function setDemo(on) {
  state.demo = on;
  clearInterval(demoTimer);
  demoTimer = null;
  if (!on) {
    if (watchId == null) { lastFix = null; view.fix = null; view.snap = null; }
    renderAll();
    return;
  }
  demoDist = 0;
  demoTimer = setInterval(() => {
    const al = state.alignment;
    if (!al || !al.length) return;
    demoDist = (demoDist + 1.4 / 4) % al.length; // 1.4 m/s, 4 Hz
    const p = al.pointAt(demoDist);
    const wobble = Math.sin(demoDist / 9) * 2.4;
    const th = (90 - p.bearing) * Math.PI / 180;
    const nx = Math.cos(th - Math.PI / 2), ny = Math.sin(th - Math.PI / 2);
    lastFix = {
      x: p.x + nx * wobble, y: p.y + ny * wobble,
      acc: 2.5, heading: p.bearing, speed: 1.4, ele: null, t: Date.now(),
      q: { source: 'demo', label: 'DEMO', rank: 1 },
      ...(state.frame ? state.frame.toLL(p.x + nx * wobble, p.y + ny * wobble) : {}),
      demo: true
    };
    view.fix = lastFix;
    renderAll();
  }, 250);
}

/* ─────────────────────────── rendering ─────────────────────────── */

function renderAll() { renderReadout(); renderTiles(); renderTarget(); view.draw(); }

function renderBadge() {
  const el = $('fixBadge');
  const q = lastFix?.q;
  if (!lastFix || !q) { el.textContent = tracking() ? 'ACQUIRING' : 'GPS OFF'; el.className = 'fixbadge'; return; }
  el.textContent = q.label;
  el.className = 'fixbadge ' + (q.rank >= 5 ? 'rtk' : q.rank === 4 ? 'float' : q.rank >= 1 ? 'single' : 'none');
}

function renderElevation() {
  const el = $('elBig');
  const u = unitLabel();
  const ele = lastFix?.ele;
  if (ele == null || !isFinite(ele)) { el.textContent = ''; return; }
  const v = u === 'ft' ? ele / M_PER_INTL_FT : ele;
  const rod = Number(state.antenna) || 0;
  el.textContent = `EL ${v.toFixed(state.decimals)} ${u}` + (rod ? ` · rod ${rod} ${u}` : '');
}

function renderReadout() {
  const al = state.alignment;
  const staEl = $('staBig'), offEl = $('offBig'), warn = $('staWarn');
  const readout = $('readout');
  renderBadge();
  renderElevation();

  if (!al) {
    readout.classList.add('off');
    staEl.textContent = '—';
    offEl.textContent = 'load an alignment to begin';
    warn.hidden = true;
    return;
  }
  if (!lastFix || lastFix.x == null) {
    readout.classList.add('off');
    staEl.textContent = '—';
    offEl.textContent = tracking() ? 'waiting for a fix…' : 'start GPS or turn on the demo walk';
    view.snap = null;
    return;
  }

  const p = al.project(lastFix.x, lastFix.y);
  view.snap = p ? p.snap : null;
  if (!p) return;

  readout.classList.remove('off');
  staEl.textContent = formatStation(p.station, state.interval, state.decimals);
  offEl.textContent = formatOffset(p.offsetDisplay, unitLabel(), state.decimals);

  const msgs = [];
  if (!p.onLine) {
    msgs.push(p.beyond < 0
      ? `${fmt(Math.abs(p.beyond), 1)} ${unitLabel()} before the start of the line`
      : `${fmt(p.beyond, 1)} ${unitLabel()} past the end of the line`);
  }
  if (lastFix.acc > 20 && !lastFix.demo) msgs.push(`Position is ±${fmt(lastFix.acc, 0)} m — treat the station as approximate`);
  if (lastFix.q?.source === 'rover' && lastFix.q.rank < 4) {
    msgs.push('Not an RTK solution — corrections are not reaching the receiver');
  }
  if (lastFix.demo) msgs.push('Demo walk — this is a simulated position, not your GPS');
  warn.hidden = !msgs.length;
  warn.textContent = msgs.join(' · ');
  state.lastProjection = p;
}

function renderTiles() {
  const u = unitLabel();
  const p = state.lastProjection;
  const fix = lastFix;
  const q = fix?.q;
  $('tAcc').textContent = fix?.acc != null ? `±${fmtAcc(fix.acc)}` : '—';
  $('tSats').textContent = q?.sats != null ? String(q.sats) : '—';
  const age = q?.ageOfDiff;
  $('tAge').textContent = age != null ? `${fmt(age, 1)} s` : (q?.source === 'rover' ? 'none' : '—');
  $('tAlign').textContent = p ? quadrantBearing(p.bearing, { seconds: false }) : '—';
  $('tToEnd').textContent = (p && state.alignment)
    ? `${fmt((state.alignment.length - p.dist) * state.alignment.unitsPerMetre, 1)} ${u}` : '—';
  $('tSpeed').textContent = fix?.speed != null && isFinite(fix.speed)
    ? `${fmt(fix.speed * 2.23694, 1)} mph` : '—';
}

function renderTarget() {
  const out = $('targetOut');
  const al = state.alignment;
  if (state.target == null || !al) { out.textContent = '—'; view.target = null; return; }
  const d = al.distanceAtStation(state.target);
  if (d == null) { out.textContent = 'that station is off this alignment'; view.target = null; return; }
  const pt = al.pointAt(d);
  view.target = { x: pt.x, y: pt.y, station: state.target };
  const p = state.lastProjection;
  if (!p) { out.textContent = `target set at ${formatStation(state.target, state.interval, 0)}`; return; }
  const delta = (d - p.dist) * al.unitsPerMetre;
  const straight = lastFix ? Math.hypot(lastFix.x - pt.x, lastFix.y - pt.y) * al.unitsPerMetre : null;
  const u = unitLabel();
  out.textContent = Math.abs(delta) < 0.05
    ? `ON STATION · ${straight != null ? fmt(straight, 1) + ' ' + u + ' straight line' : ''}`
    : `${delta > 0 ? 'AHEAD' : 'BACK'} ${fmt(Math.abs(delta), 1)} ${u}` +
      (straight != null ? ` · ${fmt(straight, 1)} ${u} straight line` : '');
}

function setPill(cls, text) {
  const pill = $('gpsPill');
  pill.className = 'pill' + (cls ? ' ' + cls : '');
  pill.textContent = text;
}

const fmt = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);

/* ─────────────────────────── marks & export ─────────────────────────── */

function addMark() {
  const al = state.alignment, p = state.lastProjection;
  if (!al || !p || !lastFix) {
    flash($('fileMsg'), 'err', 'Nothing to mark — there is no position yet.');
    return;
  }
  const note = $('markNote').value.trim();
  const q = lastFix.q || {};
  state.marks.push({
    t: Date.now(),
    station: p.station,
    offset: p.offsetDisplay,
    unit: unitLabel(),
    lat: lastFix.lat ?? null,
    lon: lastFix.lon ?? null,
    acc: lastFix.acc ?? null,
    ele: lastFix.ele ?? null,
    demo: !!lastFix.demo,
    note,
    x: lastFix.x, y: lastFix.y,
    // The quality of the fix is part of the record — a staking note without it
    // cannot be checked later.
    fix: q.label || null,
    source: q.source || null,
    sats: q.sats ?? null,
    hdop: q.hdop ?? null,
    sigmaH: q.sigmaH ?? null,
    sigmaV: q.sigmaV ?? null,
    ageOfDiff: q.ageOfDiff ?? null,
    antenna: q.antenna ?? null,
    ellipsoidAlt: q.ellipsoidAlt ?? null
  });
  $('markNote').value = '';
  renderLog();
  save();
  if (navigator.vibrate) navigator.vibrate(25);
}

function refreshMarkXY() {
  // Marks store lat/lon, so they survive a re-georeference — recompute the
  // local metres they are drawn at.
  if (!state.frame) { view.marks = state.marks.filter(m => m.x != null); return; }
  for (const m of state.marks) {
    if (m.lat != null && m.lon != null) {
      const [x, y] = state.frame.toXY(m.lat, m.lon);
      m.x = x; m.y = y;
    }
  }
  view.marks = state.marks;
}

function renderLog() {
  const list = $('logList');
  $('logCount').textContent = state.marks.length;
  if (!state.marks.length) {
    list.innerHTML = '<p class="muted">Nothing marked yet. Hit <b>Mark this station</b> on the Track tab.</p>';
    view.marks = [];
    return;
  }
  list.innerHTML = '';
  state.marks.slice().reverse().forEach(m => {
    const i = state.marks.indexOf(m);
    const row = document.createElement('div');
    row.className = 'logrow';
    const main = document.createElement('div');
    main.className = 'logrow-main';
    const sta = document.createElement('div');
    sta.className = 'logrow-sta';
    sta.textContent = `${formatStation(m.station, state.interval, state.decimals)}  ${formatOffset(m.offset, m.unit, state.decimals)}`;
    const sub = document.createElement('div');
    sub.className = 'logrow-sub';
    sub.textContent = [
      new Date(m.t).toLocaleString(),
      m.fix || null,
      m.lat != null ? `${m.lat.toFixed(7)}, ${m.lon.toFixed(7)}` : null,
      m.acc != null ? `±${fmtAcc(m.acc)}` : null,
      m.ele != null ? `EL ${fmt(m.unit === 'ft' ? m.ele / M_PER_INTL_FT : m.ele, 2)} ${m.unit}` : null,
      m.demo ? 'DEMO' : null
    ].filter(Boolean).join(' · ');
    main.append(sta, sub);
    if (m.note) {
      const note = document.createElement('div');
      note.className = 'logrow-note';
      note.textContent = m.note;
      main.append(note);
    }
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete mark');
    del.textContent = '✕';
    del.onclick = () => { state.marks.splice(i, 1); refreshMarkXY(); renderLog(); save(); view.draw(); };
    row.append(main, del);
    list.append(row);
  });
  refreshMarkXY();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  if (!state.marks.length) return;
  const head = ['n', 'station', 'station_value', 'offset', 'unit', 'latitude', 'longitude',
    'elevation_m', 'ellipsoid_h_m', 'antenna_m', 'fix', 'sats', 'hdop', 'sigma_h_m', 'sigma_v_m',
    'corr_age_s', 'accuracy_m', 'timestamp', 'note', 'simulated'];
  const rows = state.marks.map((m, i) => [
    i + 1,
    formatStation(m.station, state.interval, state.decimals),
    m.station.toFixed(3),
    m.offset.toFixed(3),
    m.unit,
    m.lat != null ? m.lat.toFixed(9) : '', m.lon != null ? m.lon.toFixed(9) : '',
    m.ele != null ? m.ele.toFixed(3) : '',
    m.ellipsoidAlt != null ? m.ellipsoidAlt.toFixed(3) : '',
    m.antenna != null ? m.antenna.toFixed(3) : '',
    m.fix || '',
    m.sats ?? '',
    m.hdop != null ? m.hdop.toFixed(2) : '',
    m.sigmaH != null ? m.sigmaH.toFixed(3) : '',
    m.sigmaV != null ? m.sigmaV.toFixed(3) : '',
    m.ageOfDiff != null ? m.ageOfDiff.toFixed(1) : '',
    m.acc != null ? m.acc.toFixed(3) : '',
    new Date(m.t).toISOString(),
    (m.note || '').replace(/"/g, '""'),
    m.demo ? 'yes' : 'no'
  ]);
  const csv = [head, ...rows].map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${v}"` : v).join(',')).join('\n');
  download(`${slug(state.alignment?.name || 'station')}-marks.csv`, csv, 'text/csv');
}

function exportGeoJson() {
  const features = state.marks.filter(m => m.lat != null).map((m, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
    properties: {
      n: i + 1,
      station: formatStation(m.station, state.interval, state.decimals),
      offset: Number(m.offset.toFixed(3)),
      unit: m.unit,
      elevation_m: m.ele != null ? Number(m.ele.toFixed(3)) : null,
      fix: m.fix || null,
      sats: m.sats ?? null,
      sigma_h_m: m.sigmaH ?? null,
      corr_age_s: m.ageOfDiff ?? null,
      accuracy_m: m.acc,
      time: new Date(m.t).toISOString(),
      note: m.note || ''
    }
  }));
  if (state.alignment && state.frame) {
    features.unshift({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: state.alignment.xy.map(([x, y]) => {
        const ll = state.frame.toLL(x, y);
        return [Number(ll.lon.toFixed(8)), Number(ll.lat.toFixed(8))];
      }) },
      properties: { name: state.alignment.name, role: 'centreline' }
    });
  }
  download(`${slug(state.alignment?.name || 'station')}.geojson`,
    JSON.stringify({ type: 'FeatureCollection', features }, null, 1), 'application/geo+json');
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'station';

/* ─────────────────────────── project tab ─────────────────────────── */

function renderProjectTab() {
  const has = !!state.file;
  $('linePick').hidden = !has || state.file.lines.length < 2;
  $('setupBlock').hidden = !has;
  $('dangerBlock').hidden = !has;
  $('georefBlock').hidden = !has || state.file.crs !== 'grid';
  if (!has) return;

  // line picker
  const list = $('lineList');
  list.innerHTML = '';
  const upm = unitsPerMetre();
  state.file.lines.forEach(l => {
    const row = document.createElement('label');
    row.className = 'linerow' + (l.id === state.lineId ? ' is-on' : '');
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'line'; radio.checked = l.id === state.lineId;
    radio.onchange = () => {
      state.lineId = l.id;
      if (l.staStart != null) state.staStart = l.staStart;
      state.equations = (l.equations || []).map(e => ({ along: e.dist, ahead: e.ahead }));
      syncSettingsInputs();
      build(); save(); renderProjectTab();
    };
    const main = document.createElement('div');
    main.className = 'linerow-main';
    const nm = document.createElement('div');
    nm.className = 'linerow-name';
    nm.textContent = l.name;
    const sub = document.createElement('div');
    sub.className = 'linerow-sub';
    sub.textContent = state.file.crs === 'geographic'
      ? `${l.coords.length} pts`
      : `${l.rawLength.toFixed(1)} ${unitLabel()} · ${l.coords.length} pts${l.layer ? ' · ' + l.layer : ''}`;
    main.append(nm, sub);
    row.append(radio, main);
    list.append(row);
  });

  // summary
  const al = state.alignment;
  $('alignSummary').textContent = al
    ? `${al.name} · ${fmt(al.lengthDisplay, 2)} ${unitLabel()} long · ` +
      `${formatStation(al.stationAt(0), state.interval, state.decimals)} to ${formatStation(al.stationAt(al.length), state.interval, state.decimals)}`
    : '';

  renderEquations();
  renderControl();
  $('projectName').textContent = al ? al.name : (state.file.fileName || 'Alignment');
}

function renderEquations() {
  const list = $('eqList');
  $('eqCount').textContent = state.equations.length;
  list.innerHTML = '';
  state.equations.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'ctrlrow';
    const main = document.createElement('div');
    main.className = 'ctrlrow-main';
    main.innerHTML = `<b>ahead ${formatStation(e.ahead, state.interval, 2)}</b>at ${fmt(e.along, 2)} ${unitLabel()} from start`;
    const del = document.createElement('button');
    del.className = 'icon-btn'; del.type = 'button'; del.textContent = '✕';
    del.onclick = () => { state.equations.splice(i, 1); build(); save(); renderProjectTab(); };
    row.append(main, del);
    list.append(row);
  });
}

function renderControl() {
  const list = $('ctrlList');
  list.innerHTML = '';
  state.control.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'ctrlrow';
    const main = document.createElement('div');
    main.className = 'ctrlrow-main';
    main.innerHTML = `<b>${c.label}</b>N ${c.src[1].toFixed(3)} · E ${c.src[0].toFixed(3)} → ${c.lat.toFixed(7)}, ${c.lon.toFixed(7)}`;
    const del = document.createElement('button');
    del.className = 'icon-btn'; del.type = 'button'; del.textContent = '✕';
    del.onclick = () => { state.control.splice(i, 1); georeference(); };
    row.append(main, del);
    list.append(row);
  });

  const out = $('fitOut');
  const t = state.transform;
  if (!t) {
    out.innerHTML = state.control.length
      ? '<b>Not enough control yet.</b> Add a second point to solve rotation and scale.'
      : '<b>No control points.</b> The alignment draws in grid units and GPS tracking is off until it is tied down.';
    return;
  }
  const u = unitLabel();
  const res = t.residuals.map((r, i) => `${state.control[i].label}: ${fmt(r * unitsPerMetre(), 2)} ${u}`).join(' · ');
  out.innerHTML =
    `<b>Georeferenced from ${state.control.length} point${state.control.length > 1 ? 's' : ''}.</b> ` +
    `Grid north is rotated ${fmt(t.rotation > 180 ? t.rotation - 360 : t.rotation, 3)}° from true north · ` +
    `scale ${t.scale.toFixed(7)} m per ${u === 'ft' ? 'foot' : 'unit'}<br>` +
    (state.control.length > 1
      ? `RMS residual <b>${fmt(t.rms * unitsPerMetre(), 2)} ${u}</b>${res ? ' · ' + res : ''}`
      : 'Single point — grid north assumed true and scale taken from the file units. Expect metres of error over any distance.');
}

function georeference() {
  const n = state.control.length;
  if (!n) { state.transform = null; state.frame = null; build(); save(); renderProjectTab(); return; }

  const frame = new LocalFrame(state.control[0].lat, state.control[0].lon);
  const pairs = state.control.map(c => ({ src: c.src, dst: frame.toXY(c.lat, c.lon) }));

  let t;
  if (n === 1) {
    const s = metresPerFileUnit();
    const [dx, dy] = pairs[0].dst, [sx, sy] = pairs[0].src;
    t = { a: s, b: 0, tx: dx - s * sx, ty: dy - s * sy, scale: s, rotation: 0, rms: 0, residuals: [0] };
  } else {
    t = fitSimilarity(pairs);
  }
  if (!t) { flash($('ctrlMsg'), 'err', 'Those control points sit on top of each other — spread them out.'); return; }

  state.frame = frame;
  state.transform = t;
  build();
  save();
  renderProjectTab();
}

function addControlPoint() {
  const msg = $('ctrlMsg');
  const lat = Number($('cpLat').value), lon = Number($('cpLon').value);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return flash(msg, 'err', 'Enter a valid latitude and longitude, or capture one from GPS.');
  }
  let src, label;
  if (ctrlSrcMode === 'grid') {
    const N = Number($('cpN').value), E = Number($('cpE').value);
    if (!isFinite(N) || !isFinite(E)) return flash(msg, 'err', 'Enter the northing and easting.');
    src = [E, N];
    label = `N ${N.toFixed(2)} E ${E.toFixed(2)}`;
  } else {
    const line = currentLine();
    if (!line) return flash(msg, 'err', 'Load an alignment first.');
    const sta = parseStation($('cpSta').value, state.interval);
    const off = Number($('cpOff').value || 0);
    if (sta == null || !isFinite(off)) return flash(msg, 'err', 'Enter a station, and an offset (0 if you are on the centreline).');
    // Solve in raw grid space: file units in, file units out.
    const gridAl = new Alignment(line.coords.map(c => [c[0], c[1]]), {
      staStart: state.staStart, unitsPerMetre: 1,
      equations: state.equations.map(e => ({ dist: e.along, ahead: e.ahead }))
    });
    const d = gridAl.distanceAtStation(sta);
    if (d == null) return flash(msg, 'err', `Station ${$('cpSta').value} is not on this alignment.`);
    const p = gridAl.pointAt(d);
    const th = p.bearing * Math.PI / 180;
    // right of increasing station = tangent turned 90° clockwise
    src = [p.x + off * Math.cos(th), p.y - off * Math.sin(th)];
    label = `STA ${formatStation(sta, state.interval, 2)} ${off ? formatOffset(off, unitLabel(), 2) : 'on ℄'}`;
  }

  state.control.push({ src, lat, lon, label });
  ['cpLat', 'cpLon', 'cpN', 'cpE', 'cpSta', 'cpOff'].forEach(id => { $(id).value = ''; });
  flash(msg, 'ok', 'Control point added.');
  georeference();
}

function captureGps() {
  const msg = $('ctrlMsg');
  if (!navigator.geolocation) return flash(msg, 'err', 'This device has no geolocation.');
  flash(msg, '', 'Reading GPS…');
  navigator.geolocation.getCurrentPosition(pos => {
    $('cpLat').value = pos.coords.latitude.toFixed(7);
    $('cpLon').value = pos.coords.longitude.toFixed(7);
    flash(msg, pos.coords.accuracy <= 8 ? 'ok' : 'warn',
      `Captured at ±${fmt(pos.coords.accuracy, 1)} m. Stand still on a known point for the best tie.`);
  }, err => flash(msg, 'err', err.message), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function flash(el, cls, text) {
  el.hidden = false;
  el.className = 'msg' + (cls ? ' ' + cls : '');
  el.textContent = text;
}

/* ─────────────────────────── settings inputs ─────────────────────────── */

function syncSettingsInputs() {
  $('selUnit').value = state.units;
  $('selUnit').disabled = state.file?.crs === 'grid';
  $('selInterval').value = String(state.interval);
  $('selDecimals').value = String(state.decimals);
  $('inpStaStart').value = formatStation(state.staStart, state.interval, 2);
  $('chkSmooth').checked = state.smooth;
  $('chkDemo').checked = state.demo;
  $('selBaud').value = String(state.baud);
  $('inpAntenna').value = state.antenna ? String(state.antenna) : '';
  const n = state.ntrip;
  $('ntHost').value = n.host || '';
  $('ntPort').value = String(n.port || 2101);
  $('ntMount').value = n.mount || '';
  $('ntUser').value = n.user || '';
  $('ntPass').value = n.pass || '';
  $('ntTls').checked = !!n.tls;
  $('ntRemember').checked = !!n.remember;
}

/* ─────────────────────────── persistence ─────────────────────────── */

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 400);
}

function doSave() {
  // Receiver and caster settings outlive any one alignment, so they are stored
  // even when no project is loaded. The caster password only if asked for.
  saveSettings();
  if (!state.file) { localStorage.removeItem(STORE_KEY); return; }
  const payload = {
    v: 1,
    file: state.file,
    lineId: state.lineId,
    units: state.units, interval: state.interval, decimals: state.decimals,
    staStart: state.staStart, equations: state.equations,
    control: state.control, transform: state.transform,
    frame: state.frame ? state.frame.toJSON() : null,
    marks: state.marks, target: state.target, smooth: state.smooth
  };
  let text = JSON.stringify(payload);
  if (text.length > MAX_STORE) {
    // Too big for localStorage — keep the chosen line only.
    const trimmed = { ...payload, file: { ...state.file, lines: state.file.lines.filter(l => l.id === state.lineId), points: [] } };
    text = JSON.stringify(trimmed);
  }
  try {
    localStorage.setItem(STORE_KEY, text);
    $('saveMsg').textContent = `Saved on this device · ${(text.length / 1024).toFixed(0)} KB · ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $('saveMsg').textContent = 'Too large to save on this device — the project will need reloading from the file next time.';
  }
}

function saveSettings() {
  const n = state.ntrip;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      source: state.source, baud: state.baud, antenna: state.antenna, smooth: state.smooth,
      ntrip: {
        host: n.host, port: n.port, mount: n.mount, user: n.user, tls: n.tls,
        remember: n.remember,
        pass: n.remember ? n.pass : ''
      }
    }));
  } catch { /* private mode; settings just will not persist */ }
}

function restoreSettings() {
  let raw;
  try { raw = localStorage.getItem(SETTINGS_KEY); } catch { return; }
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    state.baud = s.baud || state.baud;
    state.antenna = s.antenna || 0;
    if (typeof s.smooth === 'boolean') state.smooth = s.smooth;
    state.ntrip = { ...state.ntrip, ...(s.ntrip || {}) };
    setSource(s.source === 'rover' ? 'rover' : 'phone');
  } catch { /* ignore a corrupt blob rather than blocking startup */ }
}

function restore() {
  let raw;
  try { raw = localStorage.getItem(STORE_KEY); } catch { return false; }
  if (!raw) return false;
  try {
    const p = JSON.parse(raw);
    if (!p.file) return false;
    Object.assign(state, {
      file: p.file, lineId: p.lineId, units: p.units, interval: p.interval,
      decimals: p.decimals ?? 2, staStart: p.staStart, equations: p.equations || [],
      control: p.control || [], transform: p.transform || null,
      marks: p.marks || [], target: p.target ?? null, smooth: p.smooth !== false
    });
    state.frame = LocalFrame.from(p.frame);
    syncSettingsInputs();
    build();
    if (state.target != null) $('targetSta').value = formatStation(state.target, state.interval, 0);
    renderProjectTab();
    renderLog();
    return true;
  } catch (e) {
    console.warn('Could not restore the saved project', e);
    return false;
  }
}

function resetProject() {
  if (!confirm('Clear the alignment, control points and all marks from this device?')) return;
  stopGps();
  setDemo(false);
  Object.assign(state, {
    file: null, lineId: null, staStart: 0, equations: [], control: [],
    transform: null, frame: null, alignment: null, marks: [], target: null, lastProjection: null
  });
  lastFix = null;
  view.setAlignment(null);
  view.fix = null; view.snap = null; view.marks = []; view.pois = []; view.target = null;
  localStorage.removeItem(STORE_KEY);
  $('projectName').textContent = 'No alignment loaded';
  $('fileMsg').hidden = true;
  $('fileInput').value = '';
  renderLog();
  renderProjectTab();
  renderAll();
}

/* ─────────────────────────── wiring ─────────────────────────── */

function showTab(name) {
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('is-on'));
  $('tab-' + name).classList.add('is-on');
  if (name === 'track') requestAnimationFrame(() => view.draw());
  if (name === 'rover') renderRoverStats();
}

function bind() {
  document.querySelectorAll('.tab').forEach(btn => { btn.onclick = () => showTab(btn.dataset.tab); });

  // position source + receiver
  document.querySelectorAll('#srcSeg .seg-btn').forEach(b => { b.onclick = () => setSource(b.dataset.source); });
  $('btnUsb').onclick = () => connectRover('usb');
  $('btnBle').onclick = () => connectRover('ble');
  $('btnSerial').onclick = () => connectRover('serial');
  $('btnDisconnect').onclick = disconnectRover;
  $('selBaud').onchange = e => { state.baud = Number(e.target.value); save(); };
  $('inpAntenna').onchange = e => {
    state.antenna = Number(e.target.value) || 0;
    renderElevation(); save();
  };

  // corrections
  $('btnMounts').onclick = fetchMountpoints;
  $('btnNtrip').onclick = toggleNtrip;
  ['ntHost', 'ntPort', 'ntMount', 'ntUser', 'ntPass'].forEach(id => {
    $(id).onchange = () => { readNtripInputs(); save(); };
  });
  $('ntTls').onchange = () => { readNtripInputs(); save(); };
  $('ntRemember').onchange = () => { readNtripInputs(); save(); };

  // file
  $('fileInput').onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); };
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer?.files?.[0]; if (f) loadFile(f); });

  // settings
  $('selUnit').onchange = e => {
    state.units = e.target.value;
    state.interval = state.units === 'm' ? 1000 : 100;
    syncSettingsInputs(); build(); save(); renderProjectTab();
  };
  $('selInterval').onchange = e => { state.interval = Number(e.target.value); build(); save(); renderProjectTab(); };
  $('selDecimals').onchange = e => { state.decimals = Number(e.target.value); renderAll(); renderLog(); save(); };
  $('inpStaStart').onchange = e => {
    const v = parseStation(e.target.value, state.interval);
    state.staStart = v ?? 0;
    syncSettingsInputs(); build(); save(); renderProjectTab();
  };

  $('btnAddEq').onclick = () => {
    const along = Number($('eqDist').value);
    const ahead = parseStation($('eqAhead').value, state.interval);
    if (!isFinite(along) || ahead == null) return;
    state.equations.push({ along, ahead });
    state.equations.sort((a, b) => a.along - b.along);
    $('eqDist').value = ''; $('eqAhead').value = '';
    build(); save(); renderProjectTab();
  };

  // georeference
  // Scoped to the georeference block — the position-source picker uses the
  // same class and must keep its own handler.
  document.querySelectorAll('#georefBlock .seg-btn').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#georefBlock .seg-btn').forEach(x => x.classList.remove('is-on'));
      b.classList.add('is-on');
      ctrlSrcMode = b.dataset.src;
      $('srcSta').hidden = ctrlSrcMode !== 'sta';
      $('srcGrid').hidden = ctrlSrcMode !== 'grid';
    };
  });
  $('btnCapture').onclick = captureGps;
  $('btnAddCtrl').onclick = addControlPoint;

  // track
  const toggleTracking = () => {
    if (state.source === 'rover') { rover.connected ? disconnectRover() : showTab('rover'); return; }
    watchId == null ? startGps() : stopGps();
  };
  $('btnGps').onclick = toggleTracking;
  $('gpsPill').onclick = toggleTracking;
  $('btnMark').onclick = addMark;
  $('markNote').onkeydown = e => { if (e.key === 'Enter') addMark(); };
  $('chkSmooth').onchange = e => { state.smooth = e.target.checked; smoothed = null; save(); };
  $('chkDemo').onchange = e => setDemo(e.target.checked);
  $('btnFollow').onclick = () => {
    view.follow = !view.follow;
    $('btnFollow').classList.toggle('is-on', view.follow);
    view.draw();
  };
  $('btnFit').onclick = () => { $('btnFollow').classList.remove('is-on'); view.fit(); };
  $('btnZoomIn').onclick = () => view.zoomBy(1.5, view.canvas.clientWidth / 2, view.canvas.clientHeight / 2);
  $('btnZoomOut').onclick = () => view.zoomBy(1 / 1.5, view.canvas.clientWidth / 2, view.canvas.clientHeight / 2);

  const onTarget = () => {
    const v = parseStation($('targetSta').value, state.interval);
    state.target = v;
    renderTarget(); view.draw(); save();
  };
  $('targetSta').oninput = onTarget;
  $('btnClearTarget').onclick = () => { $('targetSta').value = ''; state.target = null; renderTarget(); view.draw(); save(); };

  // log
  $('btnExportCsv').onclick = exportCsv;
  $('btnExportGeo').onclick = exportGeoJson;
  $('btnClearLog').onclick = () => {
    if (!state.marks.length || !confirm('Delete every mark?')) return;
    state.marks = []; renderLog(); save(); view.draw();
  };

  // project
  $('btnSave').onclick = doSave;
  $('btnReset').onclick = resetProject;
}

/* ─────────────────────────── boot ─────────────────────────── */

view = new PlanView($('map'));
bind();
restoreSettings();

// Keep the sticky readout parked directly under the header, whatever height
// the notch and the project name conspire to make it.
const topbar = $('topbar');
const setTopH = () => document.documentElement.style.setProperty('--topH', `${topbar.offsetHeight}px`);
new ResizeObserver(setTopH).observe(topbar);
setTopH();

syncSettingsInputs();
if (!restore()) { renderProjectTab(); renderLog(); }
$('btnFollow').classList.toggle('is-on', view.follow);
renderAll();

// With ?debug in the URL the app will take NMEA from somewhere other than a
// receiver — used by the test suite, and useful for support when a crew can
// send a log but not the hardware.
if (new URLSearchParams(location.search).has('debug')) {
  window.stationDebug = {
    feedNmea: text => nmea.push(text),
    state,
    get fix() { return lastFix; },
    get roverFix() { return lastRoverFix; }
  };
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
