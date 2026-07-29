// Station — wiring. Load an alignment, watch the GPS, print where you are.

import { LocalFrame, fitSimilarity, applySimilarity, azimuth, quadrantBearing, M_PER_INTL_FT, M_PER_US_FT } from './geo.js';
import { Alignment, formatStation, parseStation, formatOffset, simplify, polylineLength } from './alignment.js';
import { parseFile } from './parse.js';
import { PlanView } from './map.js';
import { RoverLink, support as webSupport } from './rover.js';
import { NmeaReader, buildGGA } from './nmea.js';
import { NtripClient, casterDistanceKm } from './ntrip.js';
import { isNative, NativeLink, NativeNtrip, nativeInfo } from './native.js';
import { summarise, formatDistance, formatArea, formatGrade, setFootMetres } from './measure.js';
import { savePhoto, photosFor, allPhotos, deletePhoto, deletePhotosFor, urlFor, countPhotos } from './photos.js';
import { makeZip, blobBytes } from './zip.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'station.project.v1';
const SETTINGS_KEY = 'station.settings.v1';
const MAX_STORE = 3_500_000;

const UNIT_M = { meter: 1, foot: M_PER_INTL_FT, usfoot: M_PER_US_FT };

/**
 * Which foot is in force. A grid file states its own — a LandXML that says
 * USSurveyFoot is not negotiable — otherwise it is the user's setting.
 */
function footMetres(def = activeDef()) {
  if (def && def.crs === 'grid' && def.linearUnit && def.linearUnit !== 'meter') {
    return UNIT_M[def.linearUnit];
  }
  return UNIT_M[state.foot] ?? M_PER_US_FT;
}

/** Short code for exports, where "ft" alone is not good enough. */
function unitCode() {
  if (unitLabel() === 'm') return 'm';
  return footMetres() === M_PER_US_FT ? 'usft' : 'ift';
}

function footName() {
  if (unitLabel() === 'm') return 'metres';
  return footMetres() === M_PER_US_FT ? 'US survey feet' : 'international feet';
}

const state = {
  // A project is a set of alignments that share one georeference. A pipeline
  // job runs sewer, storm and water down the same trench with three different
  // stationings, and a pin has to be able to say where it is on each of them.
  projectName: '',
  alignments: [],      // [{id, name, fileName, source, crs, linearUnit, coords, points, staStart, equations}]
  activeId: null,
  autoNearest: false,  // let the closest alignment take the readout
  units: 'ft',         // display system for geographic files; forced by the file for grid files
  foot: 'usfoot',      // which foot: US survey (the default on US plans) or international
  interval: 100,
  decimals: 2,
  control: [],         // [{src:[e,n], lat, lon, label}]
  transform: null,
  frame: null,
  alignment: null,
  marks: [],
  target: null,
  smooth: true,
  demo: false,
  measure: { mode: 'distance', points: [], active: false },
  saved: [],           // finished measurements
  pinTarget: null,     // id of the pin being navigated to
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

/** The alignment the readout is following. */
function activeDef() {
  if (!state.alignments.length) return null;
  return state.alignments.find(a => a.id === state.activeId) || state.alignments[0];
}

function unitLabel(def = activeDef()) {
  if (def && def.crs === 'grid') {
    return (def.linearUnit || 'meter') === 'meter' ? 'm' : 'ft';
  }
  return state.units;
}
function metresPerFileUnit() {
  const def = state.alignments.find(a => a.crs === 'grid') || activeDef();
  return UNIT_M[def?.linearUnit] ?? 1;
}
/** Keep the measuring module on the same foot as everything else. */
function applyFootSetting() {
  setFootMetres(footMetres());
}

function unitsPerMetre(def = activeDef()) {
  if (!def) return 1;
  if (def.crs === 'grid') {
    // Grid stationing is measured in the file's own units along the file's own
    // geometry, so derive it from the fitted scale rather than a nominal factor.
    return state.transform ? 1 / state.transform.scale : 1;
  }
  return state.units === 'ft' ? 1 / footMetres(def) : 1;
}

/* ─────────────────────── building the alignments ─────────────────────── */

const built = new Map();   // alignment id -> Alignment

function currentLine() { return activeDef(); }

/**
 * One frame for the whole project. Every alignment lands in it, so a pin has a
 * single position and a station on each line rather than a position per line.
 */
function ensureFrame() {
  if (state.frame) return;
  const geo = state.alignments.find(a => a.crs === 'geographic');
  if (geo) {
    const mid = geo.coords[Math.floor(geo.coords.length / 2)];
    state.frame = new LocalFrame(mid[1], mid[0]);
  }
}

function localXY(def) {
  if (def.crs === 'geographic') {
    ensureFrame();
    if (!state.frame) return [];
    return def.coords.map(([lon, lat]) => state.frame.toXY(lat, lon));
  }
  if (state.transform) return def.coords.map(([e, n]) => applySimilarity(state.transform, e, n));
  // Not georeferenced yet — draw it in raw grid units so the plan and the
  // stationing still work; GPS stays off until control goes in.
  return def.coords.map(c => [c[0], c[1]]);
}

function build() {
  ensureFrame();
  built.clear();
  for (const def of state.alignments) {
    const upm = unitsPerMetre(def);
    const xy = localXY(def);
    if (xy.length < 2) continue;
    built.set(def.id, new Alignment(simplify(xy, 0.0005), {
      name: def.name,
      staStart: def.staStart,
      unitsPerMetre: upm,
      equations: (def.equations || []).map(e => ({ dist: e.along / upm, ahead: e.ahead }))
    }));
  }
  if (!built.has(state.activeId)) state.activeId = state.alignments[0]?.id ?? null;
  state.alignment = built.get(state.activeId) || null;

  smoothed = null; // the filter's history belongs to the old frame
  view.setAlignments(
    state.alignments.map(d => ({ id: d.id, name: d.name, al: built.get(d.id) })).filter(a => a.al),
    state.activeId,
    { label: unitLabel(), perMetre: unitsPerMetre(), interval: state.interval }
  );
  view.pois = pois();
  refreshMarkXY();
  renderAll();
}

/** Station and offset on every alignment in the project, nearest first. */
function stationsAt(x, y) {
  const out = [];
  for (const def of state.alignments) {
    const al = built.get(def.id);
    if (!al) continue;
    const proj = al.project(x, y);
    if (!proj) continue;
    out.push({
      id: def.id,
      name: def.name,
      unit: unitLabel(def),
      station: proj.station,
      offset: proj.offsetDisplay,
      distance: proj.distance,
      onLine: proj.onLine
    });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

function pois() {
  const def = activeDef();
  if (!def) return [];
  const pts = def.points || [];
  if (!pts.length) return [];
  if (def.crs === 'geographic') {
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

let pendingParse = null;   // the last file read, so more lines can be added from it
let nextAlignmentId = 1;

function makeId() { return `al${Date.now().toString(36)}${nextAlignmentId++}`; }

/** Turn a parsed line into an alignment in this project. */
function addAlignment(parsed, line) {
  const def = {
    id: makeId(),
    name: line.name,
    fileName: parsed.fileName,
    source: parsed.source,
    crs: parsed.crs,
    linearUnit: parsed.linearUnit,
    coords: line.coords,
    points: parsed.points || [],
    staStart: line.staStart ?? 0,
    equations: (line.equations || []).map(e => ({ along: e.dist, ahead: e.ahead }))
  };
  state.alignments.push(def);
  if (!state.activeId) state.activeId = def.id;

  // A grid file states its own unit, and that is not a preference.
  if (parsed.crs === 'grid') {
    state.units = (parsed.linearUnit || 'meter') === 'meter' ? 'm' : 'ft';
    if (parsed.linearUnit === 'usfoot' || parsed.linearUnit === 'foot') state.foot = parsed.linearUnit;
    state.interval = state.units === 'm' ? 1000 : 100;
  }
  applyFootSetting();
  return def;
}

async function loadFile(file) {
  const msg = $('fileMsg');
  msg.hidden = false;
  msg.className = 'msg';
  msg.textContent = `Reading ${file.name}…`;
  try {
    const parsed = await parseFile(file);
    pendingParse = parsed;

    // Anything the file calls an alignment is one. Otherwise, a single line is
    // unambiguous; several mean the crew has to say which is which.
    const declared = parsed.lines.filter(l => l.kind === 'alignment');
    const auto = declared.length ? declared : (parsed.lines.length === 1 ? parsed.lines : []);
    const added = auto.map(line => addAlignment(parsed, line));
    // The file you just opened is the one you want on the readout.
    if (added.length) state.activeId = added[0].id;

    const bits = [`${parsed.source} · ${parsed.lines.length} line${parsed.lines.length > 1 ? 's' : ''}`];
    bits.push(parsed.crs === 'grid'
      ? `grid coordinates (${parsed.linearUnit || 'units unknown'})`
      : 'latitude / longitude');
    if (auto.length) bits.push(`added ${auto.length} alignment${auto.length > 1 ? 's' : ''}`);
    msg.className = 'msg ok';
    msg.textContent = bits.join(' · ');
    if (parsed.warnings.length) {
      msg.className = 'msg warn';
      msg.textContent += ' — ' + parsed.warnings.join(' ');
    }
    if (!auto.length) {
      msg.className = 'msg warn';
      msg.textContent += ' — pick which lines to add below';
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

function removeAlignment(id) {
  const i = state.alignments.findIndex(a => a.id === id);
  if (i < 0) return;
  state.alignments.splice(i, 1);
  built.delete(id);
  // Pins keep their station on lines that are gone? No — drop those readings,
  // because a station on an alignment nobody can see is a trap.
  for (const m of state.marks) {
    if (m.stations) m.stations = m.stations.filter(st => st.id !== id);
  }
  if (state.activeId === id) state.activeId = state.alignments[0]?.id ?? null;
  build();
  save();
  renderProjectTab();
  renderLog();
}

function setActiveAlignment(id) {
  state.activeId = id;
  state.alignment = built.get(id) || null;
  view.activeId = id;
  view.units = { label: unitLabel(), perMetre: unitsPerMetre(), interval: state.interval };
  syncSettingsInputs();
  renderAll();
  renderProjectTab();
  save();
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
    $('staWarn').textContent = state.alignments.length
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

  // With several lines in a trench, the one you are walking is the one you want
  // on the readout — but only switch on a clear winner, or it flickers.
  if (state.autoNearest && state.alignments.length > 1) {
    const near = stationsAt(fix.x, fix.y);
    if (near.length > 1 && near[0].id !== state.activeId) {
      const current = near.find(n => n.id === state.activeId);
      if (!current || near[0].distance < current.distance - 1.0) {
        state.activeId = near[0].id;
        state.alignment = built.get(state.activeId) || null;
        view.activeId = state.activeId;
        view.units = { label: unitLabel(), perMetre: unitsPerMetre(), interval: state.interval };
        renderProjectTab();
      }
    }
  }
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

// Inside the Android app the shell owns the hardware and the caster socket; in a
// browser it is WebUSB/BLE and the server relay. Both present the same interface,
// so nothing below this line knows the difference.
const support = isNative
  ? { usb: true, spp: true, ble: true, serial: false, native: true }
  : { ...webSupport, spp: false, native: false };

const rover = isNative
  ? new NativeLink({
      onData: chunk => nmea.push(chunk),
      onStatus: s => onRoverStatus(s),
      onDevices: (kind, devices) => renderDeviceList(kind, devices)
    })
  : new RoverLink({
      onData: chunk => nmea.push(chunk),
      onStatus: s => onRoverStatus(s)
    });

const nmea = new NmeaReader(fix => onRoverFix(fix));

const ntrip = isNative
  ? new NativeNtrip({ onStatus: s => onNtripStatus(s), onStats: () => scheduleNtripStats() })
  : new NtripClient({
      // In the browser the corrections come back through the page, so they have
      // to be handed to the receiver here.
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
  return unitLabel() === 'ft' ? v * footMetres() : v;
}

function onRoverStatus(s) {
  const msg = $('roverMsg');
  if (s.state === 'connected') {
    flash(msg, 'ok', `Connected to ${s.detail || s.name}. Waiting for NMEA…`);
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

async function connectRover(kind, deviceId) {
  const msg = $('roverMsg');
  try {
    if (state.source !== 'rover') setSource('rover');

    // The browser shows its own device chooser. The native app does not, so the
    // choice happens here — and skipping it when there is only one device is
    // the difference between two taps and four in the field.
    if (isNative && deviceId === undefined) {
      const devices = rover.devices(kind);
      if (kind === 'ble' && devices.length === 0) {
        flash(msg, '', 'Scanning for BLE receivers…');
        renderDeviceList(kind, []);
        return;
      }
      if (devices.length === 0) {
        flash(msg, 'err', kind === 'usb'
          ? 'No USB receiver found. Check the OTG cable, and that the receiver is powered.'
          : 'No paired Bluetooth devices. Pair the receiver in Android settings first.');
        return;
      }
      if (devices.length > 1) { renderDeviceList(kind, devices); return; }
      deviceId = devices[0].id;
    }

    flash(msg, '', 'Connecting…');
    await rover.connect(kind, { baudRate: Number(state.baud), id: deviceId });
  } catch (err) {
    // A cancelled chooser is not an error worth shouting about.
    if (/cancel|no device selected|user gesture/i.test(err.message || '')) { flash(msg, '', 'No device chosen.'); return; }
    flash(msg, 'err', err.message || String(err));
  }
}

function renderDeviceList(kind, devices) {
  const wrap = $('deviceList');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!devices.length) {
    wrap.hidden = false;
    wrap.innerHTML = '<p class="muted">Looking…</p>';
    return;
  }
  wrap.hidden = false;
  const title = document.createElement('div');
  title.className = 'linerow-sub';
  title.textContent = `Pick a ${kind === 'usb' ? 'USB' : 'Bluetooth'} device`;
  wrap.append(title);
  devices.forEach(d => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'linerow';
    const main = document.createElement('div');
    main.className = 'linerow-main';
    const nm = document.createElement('div');
    nm.className = 'linerow-name';
    nm.textContent = d.name;
    const sub = document.createElement('div');
    sub.className = 'linerow-sub';
    sub.textContent = d.detail || d.id;
    main.append(nm, sub);
    row.append(main);
    row.onclick = () => { wrap.hidden = true; connectRover(kind, d.id); };
    wrap.append(row);
  });
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
    if (support.native) {
      const info = nativeInfo() || {};
      $('sourceNote').textContent =
        `Android app${info.version ? ' ' + info.version : ''} — USB, paired Bluetooth (SPP) and BLE all work, ` +
        'and corrections come straight from the caster with no relay in between.';
    } else {
      const missing = [];
      if (!support.usb) missing.push('USB');
      if (!support.ble) missing.push('Bluetooth');
      if (!support.serial) missing.push('serial ports');
      $('sourceNote').textContent = missing.length === 3
        ? 'This browser cannot reach an external receiver at all. On iOS that is a platform limit, not a setting — Safari and every iOS browser lack WebUSB and Web Bluetooth. The Android app has no such limit.'
        : missing.length
          ? `This browser supports ${['USB', 'Bluetooth', 'serial ports'].filter(x => !missing.includes(x)).join(' and ')}. Not available here: ${missing.join(', ')}.`
          : 'USB, Bluetooth and serial are all available in this browser.';
    }
    $('btnSpp').hidden = !support.spp;
    $('btnSerial').hidden = !!support.native;
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

function renderAll() { renderReadout(); renderTiles(); renderTarget(); renderMeasure(false); view.draw(); }

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
  const v = u === 'ft' ? ele / footMetres() : ele;
  const rod = Number(state.antenna) || 0;
  el.textContent = `EL ${v.toFixed(state.decimals)} ${u}` + (rod ? ` · rod ${rod} ${u}` : '');
}

function renderReadout() {
  const al = state.alignment;
  const def = activeDef();
  $('readoutLabel').textContent = (state.alignments.length > 1 && def)
    ? def.name.toUpperCase().slice(0, 18)
    : 'STATION';
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

  // Navigating to a pin: straight line and bearing, the way you would walk it.
  if (state.pinTarget) {
    const pin = state.marks.find(p => p.id === state.pinTarget);
    if (!pin || pin.x == null) { state.pinTarget = null; }
    else {
      view.target = { x: pin.x, y: pin.y, label: pin.label };
      const u = unitLabel();
      const bits = [`→ ${pin.label}`];
      if (lastFix && lastFix.x != null) {
        const dx = pin.x - lastFix.x, dy = pin.y - lastFix.y;
        bits.push(`${fmt(Math.hypot(dx, dy) * (al ? al.unitsPerMetre : (u === 'ft' ? 1 / footMetres() : 1)), 2)} ${u}`);
        bits.push(quadrantBearing(azimuth(dx, dy), { seconds: false }));
      } else if (pin.station != null) {
        bits.push(`STA ${formatStation(pin.station, state.interval, state.decimals)}`);
      }
      out.textContent = bits.join(' · ');
      return;
    }
  }

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

/* ─────────────────────────── photos ─────────────────────────── */

/**
 * A photo is worth more than the note beside it when someone asks in six weeks
 * what was in that trench. Capture goes through a normal file input so the
 * phone's own camera does the work.
 */
function attachPhoto(pinId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.setAttribute('capture', 'environment');
  input.style.display = 'none';
  document.body.append(input);
  input.onchange = async () => {
    const files = [...(input.files || [])];
    input.remove();
    for (const file of files) {
      try {
        const mark = state.marks.find(m => m.id === pinId);
        await savePhoto(pinId, file, {
          station: mark?.station ?? null,
          label: mark?.label ?? '',
          lat: mark?.lat ?? null,
          lon: mark?.lon ?? null
        });
      } catch (e) {
        flash($('fileMsg'), 'err', `Could not save that photo: ${e.message}`);
      }
    }
    renderLog();
    renderPhotoSummary();
  };
  input.click();
}

async function fillThumbs(pinId, holder) {
  let list;
  try { list = await photosFor(pinId); } catch { return; }
  holder.innerHTML = '';
  list.forEach(record => {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = urlFor(record);
    img.alt = record.name || 'site photo';
    img.loading = 'lazy';
    img.onclick = () => showPhoto(record);
    holder.append(img);
  });
}

function showPhoto(record) {
  const overlay = $('photoOverlay');
  $('photoImg').src = urlFor(record);
  $('photoCaption').textContent = [
    record.label,
    record.station != null ? formatStation(record.station, state.interval, state.decimals) : null,
    new Date(record.t).toLocaleString(),
    `${Math.round((record.size || 0) / 1024)} kB`
  ].filter(Boolean).join(' · ');
  $('btnPhotoDelete').onclick = async () => {
    await deletePhoto(record.id);
    overlay.hidden = true;
    renderLog();
    renderPhotoSummary();
  };
  overlay.hidden = false;
}

async function renderPhotoSummary() {
  try {
    const n = await countPhotos();
    $('photoCount').textContent = String(n);
    $('btnExportPhotos').disabled = n === 0;
  } catch { /* private mode, or no IndexedDB */ }
}

/** Everything a job needs to hand over: the photos and the record beside them. */
async function exportPhotoPack() {
  const list = await allPhotos();
  if (!list.length) return;
  const files = [];
  const rows = [['file', 'pin', 'label', 'station', 'offset', 'unit', 'latitude', 'longitude', 'taken']];
  const used = new Map();

  for (const record of list) {
    const mark = state.marks.find(m => m.id === record.pinId);
    const base = slug(record.label || mark?.label || 'pin');
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const name = `photos/${base}-${n}.jpg`;
    files.push({ name, data: await blobBytes(record.blob), date: new Date(record.t) });
    rows.push([
      name,
      record.pinId,
      record.label || mark?.label || '',
      mark?.station != null ? formatStation(mark.station, state.interval, state.decimals) : '',
      mark?.offset != null ? mark.offset.toFixed(2) : '',
      mark?.unitCode || mark?.unit || '',
      record.lat != null ? record.lat.toFixed(9) : '',
      record.lon != null ? record.lon.toFixed(9) : '',
      new Date(record.t).toISOString()
    ]);
  }
  const csv = rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${v}"` : v).join(',')).join('\n');
  files.push({ name: 'photos.csv', data: new TextEncoder().encode(csv) });

  const zip = makeZip(files);
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(state.projectName || state.alignment?.name || 'station')}-photos.zip`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ─────────────────────────── measuring ─────────────────────────── */

let pinMode = false;

/**
 * A measured point. Where it came from matters: a point taken standing on it
 * carries the fix quality that earned it, one tapped on the map does not, and
 * the export says which is which.
 */
function measurePoint(x, y, source, ele) {
  const p = { x, y, source, ele: ele ?? null };
  if (state.frame) {
    const ll = state.frame.toLL(x, y);
    p.lat = ll.lat; p.lon = ll.lon;
  }
  const stations = stationsAt(x, y);
  if (stations.length) {
    p.stations = stations;
    const primary = stations.find(st => st.id === state.activeId) || stations[0];
    p.station = primary.station;
    p.offset = primary.offset;
  }
  return p;
}

function addMeasurePoint(x, y, source, ele, pin) {
  state.measure.active = true;
  const p = measurePoint(x, y, source, ele);
  if (pin) { p.pinId = pin.id; p.label = pin.label; }
  state.measure.points.push(p);
  renderMeasure();
  save();
}

function addMeasurePointHere() {
  if (!lastFix || lastFix.x == null) {
    flash($('fileMsg'), 'err', 'No position yet.');
    showTab('measure');
    $('measureSub').textContent = 'No position yet — start GPS, connect the receiver, or tap the map instead.';
    return;
  }
  addMeasurePoint(lastFix.x, lastFix.y, lastFix.q?.source || 'gps', lastFix.ele);
  if (navigator.vibrate) navigator.vibrate(20);
}

function renderMeasure(redraw = true) {
  const m = state.measure;
  const units = unitLabel();
  const big = $('measureBig'), sub = $('measureSub');
  const stats = $('measureStats');

  // The live leg runs from the last point to wherever you are standing.
  const live = (lastFix && lastFix.x != null) ? { x: lastFix.x, y: lastFix.y, ele: lastFix.ele ?? null } : null;
  view.measure = m.points.length ? { mode: m.mode, points: m.points, live } : null;

  // Everything quoted describes the placed points. Where you are standing shows
  // up as a hint, never inside the total, so the saved number is the shown one.
  const chain = m.points;
  const enough = m.mode === 'area' ? chain.length >= 3 : chain.length >= 2;
  const toYou = (live && m.points.length)
    ? Math.hypot(live.x - m.points[m.points.length - 1].x, live.y - m.points[m.points.length - 1].y)
    : null;
  stats.hidden = !enough;
  $('mCount').textContent = String(m.points.length);
  $('measureStrip').hidden = !(m.active || m.points.length);
  $('stripLabel').textContent = m.mode === 'area'
    ? `Area · ${m.points.length} pts` : `Distance · ${m.points.length} pts`;

  if (!enough) {
    $('stripValue').textContent = '—';
    big.textContent = '—';
    sub.textContent = m.points.length
      ? (m.mode === 'area' ? 'Three points make an area.' : 'One more point makes a distance.')
      : 'Add points to start measuring';
    renderVertices();
    if (redraw) view.draw();
    return;
  }

  const s = summarise(chain, m.mode, units, state.decimals);
  $('stripValue').textContent = m.mode === 'area' ? s.areaText.primary : s.totalText;
  if (m.mode === 'area') {
    big.textContent = s.areaText.primary;
    sub.textContent = `${s.areaText.secondary} · perimeter ${s.perimeterText}` +
      (s.crossed ? ' · the outline crosses itself, so this area is not what you want' : '') +
      (toYou != null ? ` · ${formatDistance(toYou, units, state.decimals)} to you` : '');
    $('kA').textContent = 'Perimeter';
    $('mTotal').textContent = s.perimeterText;
    $('kB').textContent = 'Area';
    $('mStraight').textContent = s.areaText.secondary;
  } else {
    big.textContent = s.totalText;
    sub.textContent = `straight line ${s.straightText}` +
      (toYou != null ? ` · ${formatDistance(toYou, units, state.decimals)} to you` : '');
    $('kA').textContent = 'Total';
    $('mTotal').textContent = s.totalText;
    $('kB').textContent = 'Straight line';
    $('mStraight').textContent = s.straightText;
  }
  $('mLast').textContent = s.lastText || '—';
  $('mGrade').textContent = s.lastGrade || '—';
  $('mRise').textContent = s.dzText || '—';

  renderVertices();
  if (redraw) view.draw();
}

function renderVertices() {
  const list = $('vertexList');
  const m = state.measure;
  list.innerHTML = '';
  if (!m.points.length) return;
  const units = unitLabel();
  const segs = summarise(m.points, m.mode, units, state.decimals).segments;

  m.points.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'logrow';
    const main = document.createElement('div');
    main.className = 'logrow-main';
    const head = document.createElement('div');
    head.className = 'logrow-sta';
    const leg = segs[i - 1];
    head.textContent = `${i + 1}` + (leg ? ` · ${formatDistance(leg.horizontal, units, state.decimals)}` : ' · start');
    const sub = document.createElement('div');
    sub.className = 'logrow-sub';
    sub.textContent = [
      p.station != null ? `STA ${formatStation(p.station, state.interval, state.decimals)}` : null,
      p.offset != null ? formatOffset(p.offset, units, state.decimals) : null,
      p.ele != null ? `EL ${fmt(units === 'ft' ? p.ele / footMetres() : p.ele, 2)} ${units}` : null,
      p.source === 'pin' ? `from pin ${p.label || ''}`.trim() : (p.source === 'map' ? 'tapped on the map' : null)
    ].filter(Boolean).join(' · ');
    main.append(head, sub);
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.type = 'button';
    del.setAttribute('aria-label', `Delete point ${i + 1}`);
    del.textContent = '✕';
    del.onclick = () => { m.points.splice(i, 1); renderMeasure(); save(); };
    row.append(main, del);
    list.append(row);
  });
}

function saveMeasurement() {
  const m = state.measure;
  const need = m.mode === 'area' ? 3 : 2;
  if (m.points.length < need) {
    $('measureSub').textContent = `Need at least ${need} points to save this.`;
    return;
  }
  const units = unitLabel();
  const s = summarise(m.points, m.mode, units, state.decimals);
  const name = $('measureName').value.trim();
  state.saved.push({
    id: `m${Date.now()}`,
    name: name || (m.mode === 'area' ? `Area ${state.saved.length + 1}` : `Distance ${state.saved.length + 1}`),
    mode: m.mode,
    unit: units,
    points: m.points.map(p => ({ ...p })),
    total: s.total,
    straight: s.straight,
    area: s.area ?? null,
    perimeter: s.perimeter ?? null,
    t: Date.now()
  });
  $('measureName').value = '';
  state.measure = { mode: m.mode, points: [], active: false };
  setMeasuring(false);
  renderSaved();
  save();
}

function renderSaved() {
  const list = $('savedList');
  $('savedCount').textContent = String(state.saved.length);
  if (!state.saved.length) {
    list.innerHTML = '<p class="muted">Nothing saved yet.</p>';
    return;
  }
  list.innerHTML = '';
  state.saved.slice().reverse().forEach(entry => {
    const i = state.saved.indexOf(entry);
    const row = document.createElement('div');
    row.className = 'logrow';
    const main = document.createElement('div');
    main.className = 'logrow-main';
    const head = document.createElement('div');
    head.className = 'logrow-sta';
    head.textContent = entry.mode === 'area'
      ? formatArea(entry.area, entry.unit).primary
      : formatDistance(entry.total, entry.unit, state.decimals);
    const sub = document.createElement('div');
    sub.className = 'logrow-sub';
    sub.textContent = [
      entry.name,
      entry.mode === 'area'
        ? `${formatArea(entry.area, entry.unit).secondary} · perimeter ${formatDistance(entry.perimeter, entry.unit, state.decimals)}`
        : `${entry.points.length} points · straight ${formatDistance(entry.straight, entry.unit, state.decimals)}`,
      new Date(entry.t).toLocaleString()
    ].filter(Boolean).join(' · ');
    main.append(head, sub);

    const load = document.createElement('button');
    load.className = 'icon-btn';
    load.type = 'button';
    load.title = 'Show on the map';
    load.textContent = '↺';
    load.onclick = () => {
      state.measure = { mode: entry.mode, points: entry.points.map(p => ({ ...p })) };
      document.querySelectorAll('#measureSeg .seg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.mode === entry.mode));
      renderMeasure();
      showTab('track');
    };
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.type = 'button';
    del.textContent = '✕';
    del.onclick = () => { state.saved.splice(i, 1); renderSaved(); save(); };
    row.append(main, load, del);
    list.append(row);
  });
}

function exportMeasurements() {
  if (!state.saved.length) return;
  const head = ['measurement', 'type', 'point', 'station', 'offset', 'unit', 'latitude', 'longitude',
    'elevation_m', 'leg', 'running_total', 'total', 'area', 'area_secondary', 'perimeter', 'source', 'timestamp'];
  const rows = [];
  for (const entry of state.saved) {
    const s = summarise(entry.points, entry.mode, entry.unit, state.decimals);
    let running = 0;
    entry.points.forEach((p, i) => {
      const leg = s.segments[i - 1];
      if (leg) running += leg.horizontal;
      rows.push([
        entry.name, entry.mode, i + 1,
        p.station != null ? formatStation(p.station, state.interval, state.decimals) : '',
        p.offset != null ? p.offset.toFixed(3) : '',
        entry.unit,
        p.lat != null ? p.lat.toFixed(9) : '', p.lon != null ? p.lon.toFixed(9) : '',
        p.ele != null ? p.ele.toFixed(3) : '',
        leg ? toUnit(leg.horizontal, entry.unit).toFixed(3) : '',
        toUnit(running, entry.unit).toFixed(3),
        i === 0 ? toUnit(entry.total, entry.unit).toFixed(3) : '',
        i === 0 && entry.area != null ? formatArea(entry.area, entry.unit).primary : '',
        i === 0 && entry.area != null ? formatArea(entry.area, entry.unit).secondary : '',
        i === 0 && entry.perimeter != null ? toUnit(entry.perimeter, entry.unit).toFixed(3) : '',
        p.source || '',
        i === 0 ? new Date(entry.t).toISOString() : ''
      ]);
    });
  }
  const csv = [head, ...rows].map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${v}"` : v).join(',')).join('\n');
  download(`${slug(state.alignment?.name || 'station')}-measurements.csv`, csv, 'text/csv');
}

function exportMeasurementsGeo() {
  if (!state.saved.length) return;
  const features = state.saved
    .filter(e => e.points.every(p => p.lat != null))
    .map(e => {
      const ring = e.points.map(p => [Number(p.lon.toFixed(8)), Number(p.lat.toFixed(8))]);
      const closed = e.mode === 'area';
      if (closed && ring.length > 2) ring.push(ring[0]);
      return {
        type: 'Feature',
        geometry: closed && ring.length > 3
          ? { type: 'Polygon', coordinates: [ring] }
          : { type: 'LineString', coordinates: ring },
        properties: {
          name: e.name,
          type: e.mode,
          unit: e.unit,
          total: Number(toUnit(e.total, e.unit).toFixed(3)),
          area: e.area != null ? formatArea(e.area, e.unit).primary : null,
          area_secondary: e.area != null ? formatArea(e.area, e.unit).secondary : null,
          perimeter: e.perimeter != null ? Number(toUnit(e.perimeter, e.unit).toFixed(3)) : null,
          time: new Date(e.t).toISOString()
        }
      };
    });
  if (!features.length) return;
  download(`${slug(state.alignment?.name || 'station')}-measurements.geojson`,
    JSON.stringify({ type: 'FeatureCollection', features }, null, 1), 'application/geo+json');
}

const toUnit = (metres, unit) => unit === 'ft' ? metres / footMetres() : metres;

/** One tap on the map means different things depending on what you are doing. */
function onMapTap(x, y, pinIndex) {
  if (state.measure.active) {
    // Tapping a pin measures from the pin itself, not from a thumb-width away.
    const pin = pinIndex != null ? state.marks[pinIndex] : null;
    if (pin && pin.x != null) addMeasurePoint(pin.x, pin.y, 'pin', pin.ele, pin);
    else addMeasurePoint(x, y, 'map', null);
    return;
  }
  if (pinMode) { dropPinAt(x, y); return; }
  if (pinIndex != null) { selectPin(pinIndex); return; }
}

/**
 * Measuring is armed rather than tab-bound: the map lives on the Track tab, and
 * that is where the taps have to land.
 */
function setMeasuring(on) {
  state.measure.active = on;
  pinMode = pinMode && !on;      // one map gesture at a time
  $('btnPinMode').classList.toggle('is-on', pinMode);
  $('btnStartMeasure').textContent = on ? 'Measuring…' : 'Start measuring';
  $('btnStartMeasure').classList.toggle('on', on);
  renderMeasure();
  save();
}

/* ─────────────────────────── marks & export ─────────────────────────── */

function addMark() {
  const al = state.alignment, p = state.lastProjection;
  if (!al || !p || !lastFix) {
    flash($('fileMsg'), 'err', 'Nothing to mark — there is no position yet.');
    return;
  }
  const note = $('markNote').value.trim();
  const q = lastFix.q || {};
  const stations = stationsAt(lastFix.x, lastFix.y);
  state.marks.push({
    id: `p${Date.now()}`,
    // Station and offset on every line in the project, nearest first. On a job
    // where sewer, storm and water share a trench, one of those is the answer
    // and you do not always know which until later.
    stations,
    alignmentId: state.activeId,
    label: note || `Pin ${state.marks.length + 1}`,
    t: Date.now(),
    station: (stations.find(st => st.id === state.activeId) || stations[0] || {}).station ?? p.station,
    offset: (stations.find(st => st.id === state.activeId) || stations[0] || {}).offset ?? p.offsetDisplay,
    unit: unitLabel(),
    unitCode: unitCode(),
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

/** A pin placed by tapping the plan, rather than by standing on it. */
function dropPinAt(x, y) {
  const stations = stationsAt(x, y);
  const primary = stations.find(st => st.id === state.activeId) || stations[0] || null;
  const ll = state.frame ? state.frame.toLL(x, y) : null;
  const label = $('markNote').value.trim();
  state.marks.push({
    id: `p${Date.now()}`,
    label: label || `Pin ${state.marks.length + 1}`,
    t: Date.now(),
    stations,
    alignmentId: state.activeId,
    station: primary ? primary.station : null,
    offset: primary ? primary.offset : null,
    unit: unitLabel(),
    lat: ll ? ll.lat : null,
    lon: ll ? ll.lon : null,
    acc: null, ele: null,
    // No fix quality, because nobody stood here — the export says so plainly.
    fix: 'MAP', source: 'map',
    note: '', x, y
  });
  $('markNote').value = '';
  renderLog();
  save();
  view.draw();
}

function selectPin(index) {
  view.selectedMark = index;
  const m = state.marks[index];
  if (!m) return;
  state.pinTarget = m.id;
  state.target = null;
  $('targetSta').value = '';
  renderTarget();
  view.draw();
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
    sta.textContent = m.station != null
      ? `${formatStation(m.station, state.interval, state.decimals)}  ${formatOffset(m.offset, m.unit, state.decimals)}`
      : (m.label || 'Pin');
    const sub = document.createElement('div');
    sub.className = 'logrow-sub';
    sub.textContent = [
      new Date(m.t).toLocaleString(),
      m.fix || null,
      m.lat != null ? `${m.lat.toFixed(7)}, ${m.lon.toFixed(7)}` : null,
      m.acc != null ? `±${fmtAcc(m.acc)}` : null,
      m.ele != null ? `EL ${fmt(m.unit === 'ft' ? m.ele / footMetres() : m.ele, 2)} ${m.unit}` : null,
      m.demo ? 'DEMO' : null
    ].filter(Boolean).join(' · ');
    main.append(sta, sub);

    // Every alignment this pin has a reading on. On a shared trench that is the
    // whole point: one pin, a station on the sewer and a station on the storm.
    if (m.stations && m.stations.length > 1) {
      const lines = document.createElement('div');
      lines.className = 'logrow-stations';
      m.stations.forEach(st => {
        const row2 = document.createElement('div');
        row2.className = 'stationline' + (st.id === m.alignmentId ? ' is-primary' : '');
        row2.textContent = `${st.name}  ${formatStation(st.station, state.interval, state.decimals)}  ${formatOffset(st.offset, st.unit, state.decimals)}`;
        lines.append(row2);
      });
      main.append(lines);
    }

    if (m.label && m.station != null) {
      const label = document.createElement('div');
      label.className = 'logrow-note';
      label.textContent = m.label;
      main.append(label);
    }
    if (m.note && m.note !== m.label) {
      const note = document.createElement('div');
      note.className = 'logrow-note';
      note.textContent = m.note;
      main.append(note);
    }
    row.classList.toggle('is-on', state.pinTarget === m.id);

    const shots = document.createElement('div');
    shots.className = 'thumbs';
    shots.dataset.pin = m.id;
    main.append(shots);
    fillThumbs(m.id, shots);

    const cam = document.createElement('button');
    cam.className = 'icon-btn';
    cam.type = 'button';
    cam.title = 'Add a photo';
    cam.setAttribute('aria-label', 'Add a photo to this pin');
    cam.textContent = '\u{1F4F7}';
    cam.onclick = () => attachPhoto(m.id);

    const go = document.createElement('button');
    go.className = 'icon-btn';
    go.type = 'button';
    go.title = 'Navigate to this pin';
    go.setAttribute('aria-label', 'Navigate to this pin');
    go.textContent = '➤';
    go.onclick = () => { selectPin(i); renderLog(); showTab('track'); };

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete pin');
    del.textContent = '✕';
    del.onclick = () => {
      if (state.pinTarget === m.id) { state.pinTarget = null; view.target = null; }
      deletePhotosFor(m.id).catch(() => {});
      state.marks.splice(i, 1);
      view.selectedMark = null;
      refreshMarkXY(); renderLog(); renderTarget(); save(); view.draw();
    };
    row.append(main, cam, go, del);
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
    m.unitCode || m.unit,
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
      unit: m.unitCode || m.unit,
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
  const has = state.alignments.length > 0;
  const anyGrid = state.alignments.some(a => a.crs === 'grid');
  $('setupBlock').hidden = !has;
  $('dangerBlock').hidden = !has;
  $('georefBlock').hidden = !anyGrid;
  $('alignBlock').hidden = !has;
  renderAlignments();
  renderLinePicker();
  if (!has) { $('projectName').textContent = state.projectName || 'No alignment loaded'; return; }

  const al = state.alignment;
  const def = activeDef();
  $('alignSummary').textContent = al
    ? `${al.name} · ${fmt(al.lengthDisplay, 2)} ${unitLabel()} long · ` +
      `${formatStation(al.stationAt(0), state.interval, state.decimals)} to ${formatStation(al.stationAt(al.length), state.interval, state.decimals)}` +
      ` · ${footName()}`
    : '';

  renderEquations();
  renderControl();
  $('projectName').textContent = state.projectName || (al ? al.name : def.fileName || 'Alignment');
}

/** The alignments in this project: which one has the readout, and what else is here. */
function renderAlignments() {
  const list = $('alignList');
  list.innerHTML = '';
  $('alignCount').textContent = String(state.alignments.length);
  $('chkAutoNearest').checked = state.autoNearest;

  state.alignments.forEach(def => {
    const al = built.get(def.id);
    const row = document.createElement('label');
    row.className = 'linerow' + (def.id === state.activeId ? ' is-on' : '');
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'activeAlignment';
    radio.checked = def.id === state.activeId;
    radio.onchange = () => setActiveAlignment(def.id);

    const main = document.createElement('div');
    main.className = 'linerow-main';
    const nm = document.createElement('input');
    nm.type = 'text';
    nm.className = 'inline-name';
    nm.value = def.name;
    nm.onchange = () => {
      def.name = nm.value.trim() || 'Alignment';
      build(); save(); renderProjectTab(); renderLog();
    };
    const sub = document.createElement('div');
    sub.className = 'linerow-sub';
    sub.textContent = al
      ? `${fmt(al.lengthDisplay, 1)} ${unitLabel(def)} · ` +
        `${formatStation(al.stationAt(0), state.interval, 0)} to ${formatStation(al.stationAt(al.length), state.interval, 0)}` +
        ` · ${def.source}`
      : `${def.source} · ${def.coords.length} pts`;
    main.append(nm, sub);

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.type = 'button';
    del.setAttribute('aria-label', `Remove ${def.name}`);
    del.textContent = '✕';
    del.onclick = e => { e.preventDefault(); removeAlignment(def.id); };

    row.append(radio, main, del);
    list.append(row);
  });
}

/** Lines in the loaded file that are not yet alignments in the project. */
function renderLinePicker() {
  const wrap = $('linePick');
  const list = $('lineList');
  list.innerHTML = '';
  const used = new Set(state.alignments.map(a => `${a.fileName}::${a.name}`));
  const spare = pendingParse
    ? pendingParse.lines.filter(l => !used.has(`${pendingParse.fileName}::${l.name}`))
    : [];
  wrap.hidden = !spare.length;
  if (!spare.length) return;

  spare.forEach(l => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'linerow';
    const main = document.createElement('div');
    main.className = 'linerow-main';
    const nm = document.createElement('div');
    nm.className = 'linerow-name';
    nm.textContent = l.name;
    const sub = document.createElement('div');
    sub.className = 'linerow-sub';
    sub.textContent = pendingParse.crs === 'geographic'
      ? `${l.coords.length} pts`
      : `${l.rawLength.toFixed(1)} ${unitLabel()} · ${l.coords.length} pts${l.layer ? ' · ' + l.layer : ''}`;
    main.append(nm, sub);
    const add = document.createElement('span');
    add.className = 'add-mark';
    add.textContent = '+';
    row.append(main, add);
    row.onclick = () => {
      const def = addAlignment(pendingParse, l);
      state.activeId = def.id;
      syncSettingsInputs();
      build(); save(); renderProjectTab();
    };
    list.append(row);
  });
}

function renderEquations() {
  const list = $('eqList');
  const def = activeDef();
  const equations = def ? def.equations : [];
  $('eqCount').textContent = equations.length;
  list.innerHTML = '';
  equations.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'ctrlrow';
    const main = document.createElement('div');
    main.className = 'ctrlrow-main';
    main.innerHTML = `<b>ahead ${formatStation(e.ahead, state.interval, 2)}</b>at ${fmt(e.along, 2)} ${unitLabel()} from start`;
    const del = document.createElement('button');
    del.className = 'icon-btn'; del.type = 'button'; del.textContent = '✕';
    del.onclick = () => { equations.splice(i, 1); build(); save(); renderProjectTab(); };
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
    `scale ${t.scale.toFixed(7)} m per ${u === 'ft' ? (metresPerFileUnit() === M_PER_US_FT ? 'US survey foot' : 'foot') : 'unit'}<br>` +
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
      staStart: line.staStart, unitsPerMetre: 1,
      equations: (line.equations || []).map(e => ({ dist: e.along, ahead: e.ahead }))
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
  $('selUnit').value = state.units === 'm' ? 'm' : state.foot;
  $('selUnit').disabled = state.alignments.some(a => a.crs === 'grid');
  $('selInterval').value = String(state.interval);
  $('selDecimals').value = String(state.decimals);
  $('inpStaStart').value = formatStation(activeDef()?.staStart ?? 0, state.interval, 2);
  $('chkSmooth').checked = state.smooth;
  $('chkDemo').checked = state.demo;
  $('chkAutoNearest').checked = state.autoNearest;
  $('inpProjectName').value = state.projectName || '';
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
  if (!state.alignments.length) { localStorage.removeItem(STORE_KEY); return; }
  const payload = {
    v: 1,
    alignments: state.alignments,
    activeId: state.activeId,
    autoNearest: state.autoNearest,
    projectName: state.projectName,
    units: state.units, foot: state.foot, interval: state.interval, decimals: state.decimals,
    control: state.control, transform: state.transform,
    frame: state.frame ? state.frame.toJSON() : null,
    marks: state.marks, target: state.target, smooth: state.smooth,
    measure: state.measure, saved: state.saved, pinTarget: state.pinTarget
  };
  let text = JSON.stringify(payload);
  if (text.length > MAX_STORE) {
    // Too big for localStorage — keep the chosen line only.
    // Point clouds from a survey file are the bulky part and are only decoration.
    const trimmed = { ...payload, alignments: state.alignments.map(a => ({ ...a, points: [] })) };
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
      units: state.units, foot: state.foot,
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
    if (s.units) state.units = s.units;
    if (s.foot) state.foot = s.foot;
    if (s.units) state.interval = s.units === 'm' ? 1000 : 100;
    state.antenna = s.antenna || 0;
    if (typeof s.smooth === 'boolean') state.smooth = s.smooth;
    state.ntrip = { ...state.ntrip, ...(s.ntrip || {}) };
    applyFootSetting();
    setSource(s.source === 'rover' ? 'rover' : 'phone');
  } catch { /* ignore a corrupt blob rather than blocking startup */ }
}

function restore() {
  let raw;
  try { raw = localStorage.getItem(STORE_KEY); } catch { return false; }
  if (!raw) return false;
  try {
    const p = JSON.parse(raw);
    if (!p.alignments || !p.alignments.length) return false;
    Object.assign(state, {
      alignments: p.alignments, activeId: p.activeId, autoNearest: !!p.autoNearest,
      projectName: p.projectName || '', units: p.units, interval: p.interval,
      decimals: p.decimals ?? 2,
      control: p.control || [], transform: p.transform || null,
      marks: p.marks || [], target: p.target ?? null, smooth: p.smooth !== false,
      measure: p.measure && Array.isArray(p.measure.points) ? { active: false, ...p.measure } : { mode: 'distance', points: [], active: false },
      saved: p.saved || [], pinTarget: p.pinTarget ?? null
    });
    state.frame = LocalFrame.from(p.frame);
    if (p.foot) state.foot = p.foot;
    applyFootSetting();
    syncSettingsInputs();
    build();
    if (state.target != null) $('targetSta').value = formatStation(state.target, state.interval, 0);
    renderProjectTab();
    renderLog();
    renderSaved();
    renderMeasure();
    document.querySelectorAll('#measureSeg .seg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.mode === state.measure.mode));
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
  pendingParse = null;
  built.clear();
  Object.assign(state, {
    alignments: [], activeId: null, control: [],
    transform: null, frame: null, alignment: null, marks: [], target: null, lastProjection: null,
    measure: { mode: state.measure.mode, points: [], active: false }, saved: [], pinTarget: null
  });
  lastFix = null;
  view.setAlignment(null);
  view.fix = null; view.snap = null; view.marks = []; view.pois = []; view.target = null;
  view.measure = null; view.selectedMark = null;
  localStorage.removeItem(STORE_KEY);
  $('projectName').textContent = 'No alignment loaded';
  $('fileMsg').hidden = true;
  $('fileInput').value = '';
  renderLog();
  renderSaved();
  renderMeasure(false);
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
  if (name === 'measure') renderMeasure();
}

function bind() {
  document.querySelectorAll('.tab').forEach(btn => { btn.onclick = () => showTab(btn.dataset.tab); });

  // position source + receiver
  document.querySelectorAll('#srcSeg .seg-btn').forEach(b => { b.onclick = () => setSource(b.dataset.source); });
  $('btnUsb').onclick = () => connectRover('usb');
  $('btnSpp').onclick = () => connectRover('spp');
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
    const v = e.target.value;
    state.units = v === 'm' ? 'm' : 'ft';
    if (v !== 'm') state.foot = v;
    state.interval = state.units === 'm' ? 1000 : 100;
    applyFootSetting();
    syncSettingsInputs(); build(); save(); renderProjectTab(); renderLog(); renderSaved();
  };
  $('selInterval').onchange = e => { state.interval = Number(e.target.value); build(); save(); renderProjectTab(); };
  $('selDecimals').onchange = e => { state.decimals = Number(e.target.value); renderAll(); renderLog(); save(); };
  $('inpStaStart').onchange = e => {
    const v = parseStation(e.target.value, state.interval);
    const def = activeDef();
    if (def) def.staStart = v ?? 0;
    syncSettingsInputs(); build(); save(); renderProjectTab();
  };

  $('btnAddEq').onclick = () => {
    const along = Number($('eqDist').value);
    const ahead = parseStation($('eqAhead').value, state.interval);
    if (!isFinite(along) || ahead == null) return;
    const def = activeDef();
    if (!def) return;
    def.equations.push({ along, ahead });
    def.equations.sort((a, b) => a.along - b.along);
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
  $('btnPinMode').onclick = () => {
    pinMode = !pinMode;
    if (pinMode && state.measure.active) setMeasuring(false);
    $('btnPinMode').classList.toggle('is-on', pinMode);
  };

  // measuring
  document.querySelectorAll('#measureSeg .seg-btn').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#measureSeg .seg-btn').forEach(x => x.classList.remove('is-on'));
      b.classList.add('is-on');
      state.measure.mode = b.dataset.mode;
      renderMeasure();
      save();
    };
  });
  $('btnStartMeasure').onclick = () => { setMeasuring(!state.measure.active); if (state.measure.active) showTab('track'); };
  $('btnAddPoint').onclick = addMeasurePointHere;
  $('btnUndoPoint').onclick = () => { state.measure.points.pop(); renderMeasure(); save(); };
  $('btnClearMeasure').onclick = () => { state.measure.points = []; setMeasuring(false); };
  $('btnStripAdd').onclick = addMeasurePointHere;
  $('btnStripUndo').onclick = () => { state.measure.points.pop(); renderMeasure(); save(); };
  $('btnStripSave').onclick = saveMeasurement;
  $('btnStripStop').onclick = () => { state.measure.points = []; setMeasuring(false); };
  $('btnSaveMeasure').onclick = saveMeasurement;
  $('btnExportMeasure').onclick = exportMeasurements;
  $('btnExportMeasureGeo').onclick = exportMeasurementsGeo;
  $('btnZoomIn').onclick = () => view.zoomBy(1.5, view.canvas.clientWidth / 2, view.canvas.clientHeight / 2);
  $('btnZoomOut').onclick = () => view.zoomBy(1 / 1.5, view.canvas.clientWidth / 2, view.canvas.clientHeight / 2);

  const onTarget = () => {
    const v = parseStation($('targetSta').value, state.interval);
    state.target = v;
    if (v != null) { state.pinTarget = null; view.selectedMark = null; }
    renderTarget(); view.draw(); save();
  };
  $('targetSta').oninput = onTarget;
  $('btnClearTarget').onclick = () => {
    $('targetSta').value = '';
    state.target = null;
    state.pinTarget = null;
    view.selectedMark = null;
    renderTarget(); renderLog(); view.draw(); save();
  };

  // log
  $('btnExportCsv').onclick = exportCsv;
  $('btnExportPhotos').onclick = exportPhotoPack;
  $('btnPhotoClose').onclick = () => { $('photoOverlay').hidden = true; };
  $('btnPinPhoto').onclick = () => {
    addMark();
    const last = state.marks[state.marks.length - 1];
    if (last) attachPhoto(last.id);
  };
  $('btnExportGeo').onclick = exportGeoJson;
  $('btnClearLog').onclick = () => {
    if (!state.marks.length || !confirm('Delete every mark?')) return;
    state.marks = []; renderLog(); save(); view.draw();
  };

  // project
  $('chkAutoNearest').onchange = e => { state.autoNearest = e.target.checked; save(); };
  $('inpProjectName').onchange = e => {
    state.projectName = e.target.value.trim();
    $('projectName').textContent = state.projectName || (state.alignment?.name ?? 'Alignment');
    save();
  };
  $('btnSave').onclick = doSave;
  $('btnReset').onclick = resetProject;
}

/* ─────────────────────────── boot ─────────────────────────── */

view = new PlanView($('map'));
view.onTap = onMapTap;
applyFootSetting();
bind();

// Inside the app, several of the browser's limits simply do not apply, and the
// page should not keep apologising for them.
if (isNative) {
  $('ntripNote').textContent =
    'The app connects straight to the caster and feeds the receiver directly — no relay, and it keeps ' +
    'running with the screen off. Your password is sent to the caster and stored only if you ask for it.';
  $('platformNotes').innerHTML =
    '<li><b>USB</b> — an OTG cable to the receiver. Steadiest link, and it powers the board.</li>' +
    '<li><b>Bluetooth (paired)</b> — classic SPP, the same module SurPad uses. Pair it in Android settings first.</li>' +
    '<li><b>Bluetooth (BLE)</b> — for u-blox and HM-10 style serial modules.</li>' +
    '<li>Corrections keep streaming with the screen off; a notification shows while the link is up.</li>';
}

restoreSettings();

// Keep the sticky readout parked directly under the header, whatever height
// the notch and the project name conspire to make it.
const topbar = $('topbar');
const setTopH = () => document.documentElement.style.setProperty('--topH', `${topbar.offsetHeight}px`);
new ResizeObserver(setTopH).observe(topbar);
setTopH();

syncSettingsInputs();
if (!restore()) { renderProjectTab(); renderLog(); renderSaved(); }
renderPhotoSummary();
$('btnFollow').classList.toggle('is-on', view.follow);
renderAll();

// With ?debug in the URL the app will take NMEA from somewhere other than a
// receiver — used by the test suite, and useful for support when a crew can
// send a log but not the hardware.
if (new URLSearchParams(location.search).has('debug')) {
  window.stationDebug = {
    feedNmea: text => nmea.push(text),
    state,
    view,
    get fix() { return lastFix; },
    get roverFix() { return lastRoverFix; }
  };
}

// The APK already carries every file, so the offline worker is browser-only.
if (!isNative && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
