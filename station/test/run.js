// Browser test suite. Needs playwright and a chromium build available:
//   npm i -D playwright && npx playwright install chromium
//   node station/test/run.js
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); }
catch { console.error('playwright not found — see the header of this file.'); process.exit(2); }

const REPO = path.resolve(__dirname, '..', '..');
const FIX = path.join(__dirname, 'fixtures');
execFileSync(process.execPath, [path.join(__dirname, 'make-fixtures.js')], { stdio: 'ignore' });
const EXP = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const PORT = Number(process.env.PORT || 3111);
const BASE = `http://localhost:${PORT}/station/?debug`;

// Independent NMEA checksum, so the fixtures do not lean on the app's own code.
function nmea(body, corrupt = false) {
  let c = 0;
  for (const ch of body) c ^= ch.charCodeAt(0);
  if (corrupt) c ^= 0xff;
  return `$${body}*${c.toString(16).toUpperCase().padStart(2, '0')}`;
}
// Two RTCM 3 frames back to back, message 1005 then 1074.
function rtcmBytes() {
  const frame = (type, len) => {
    const b = [0xd3, (len >> 8) & 3, len & 0xff, type >> 4, (type & 0xf) << 4];
    while (b.length < len + 3) b.push(0);
    return [...b, 1, 2, 3];
  };
  return [...frame(1005, 12), ...frame(1074, 20)];
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const near = (name, got, want, tol) =>
  ok(`${name} (${Number(got).toFixed(4)} ≈ ${Number(want).toFixed(4)})`, Math.abs(got - want) <= tol,
     `off by ${Math.abs(got - want)}`);

(async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
  await new Promise(r => setTimeout(r, 700));

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({
    permissions: ['geolocation'],
    geolocation: { latitude: 33.8, longitude: -117.2, accuracy: 3 },
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  const texts = {
    landxml: fs.readFileSync(path.join(FIX, 'alignment.xml'), 'utf8'),
    dxf: fs.readFileSync(path.join(FIX, 'plan.dxf'), 'utf8'),
    gpx: fs.readFileSync(path.join(FIX, 'track.gpx'), 'utf8'),
    csv: fs.readFileSync(path.join(FIX, 'points.csv'), 'utf8'),
    gga: nmea('GPGGA,120000.00,3348.00000,N,11711.70000,W,4,18,0.6,120.5,M,-33.2,M,1.2,0123'),
    gst: nmea('GPGST,120000.00,0.010,0.012,0.008,31.0,0.008,0.011,0.019'),
    single: nmea('GPGGA,120001.00,3348.00000,N,11711.70000,W,1,07,2.4,120.5,M,-33.2,M,,'),
    badGga: nmea('GPGGA,120002.00,3348.00000,N,11711.70000,W,4,18,0.6,999.9,M,-33.2,M,1.2,0123', true),
    sourcetable: [
      'STR;NEAR;Riverside;RTCM 3.2;1005(1),1074(1);2;GPS+GLO;NET;USA;33.90;-117.40;1;0;sNTRIP;none;B;N;9600;',
      'STR;FAR;Barstow;RTCM 3.0;1004(1);2;GPS;NET;USA;34.90;-117.02;0;0;sNTRIP;none;B;N;9600;'
    ].join('\r\n'),
    rtcm: rtcmBytes()
  };

  console.log('\n— parsing and stationing —');
  const r = await page.evaluate(async (t) => {
    const { parseLandXML } = await import('./js/landxml.js');
    const { parseDXF } = await import('./js/dxf.js');
    const { parseGPX, parseCSV } = await import('./js/parse.js');
    const { Alignment, formatStation, parseStation, formatOffset, simplify } = await import('./js/alignment.js');
    const { LocalFrame, quadrantBearing } = await import('./js/geo.js');
    const out = {};

    const lx = parseLandXML(t.landxml);
    const line = lx.lines[0];
    const al = new Alignment(line.coords, {
      staStart: line.staStart, unitsPerMetre: 1,
      equations: line.equations.map(e => ({ dist: e.dist, ahead: e.ahead }))
    });
    out.lx = {
      crs: lx.crs, unit: lx.linearUnit, nLines: lx.lines.length, name: line.name,
      staStart: line.staStart, eq: line.equations,
      length: al.length,
      staAt0: al.stationAt(0),
      staAtEnd: al.stationAt(al.length),
      ptAt500: al.pointAt(500),
      distAt1250: al.distanceAtStation(1250),
      proj: al.project(10250, 4990),
      warnings: lx.warnings
    };

    const dx = parseDXF(t.dxf);
    const dal = new Alignment(dx.lines[0].coords, { unitsPerMetre: 1 });
    out.dxf = { unit: dx.linearUnit, nLines: dx.lines.length, first: dx.lines[0].name, length: dal.length, crs: dx.crs };

    const gp = parseGPX(t.gpx);
    const mid = gp.lines[0].coords[0];
    const fr = new LocalFrame(mid[1], mid[0]);
    const gal = new Alignment(gp.lines[0].coords.map(([lo, la]) => fr.toXY(la, lo)), { unitsPerMetre: 1 });
    out.gpx = { crs: gp.crs, name: gp.lines[0].name, length: gal.length };

    const cv = parseCSV(t.csv);
    out.csv = { crs: cv.crs, pts: cv.points.length, n: cv.lines[0].coords.length };

    out.fmt = {
      a: formatStation(2985.398163, 100, 2),
      b: formatStation(1250, 100, 2),
      c: formatStation(99.999, 100, 2),
      d: formatStation(1250.25, 1000, 2),
      e: parseStation('12+50.25'),
      f: parseStation('1250.25'),
      g: formatOffset(10, 'ft', 2),
      h: formatOffset(-3.5, 'ft', 2),
      i: quadrantBearing(90), j: quadrantBearing(135),
      k: quadrantBearing(89.9999999), l: quadrantBearing(45.5, { seconds: false })
    };
    out.simplify = { before: 5, after: simplify([[0, 0], [1, 0.001], [2, 0], [3, -0.001], [4, 0]], 0.01).length };

    // ---- NMEA ----
    const { NmeaReader, NmeaTokenizer, buildGGA, parseLatLon } = await import('./js/nmea.js');
    const { parseSourcetable, RtcmFramer, casterDistanceKm } = await import('./js/ntrip.js');
    const fixes = [];
    const reader = new NmeaReader(f => fixes.push(f));
    reader.push(t.gst + '\r\n');
    reader.push(t.gga + '\r\n');
    reader.push(t.badGga + '\r\n');          // bad checksum, must be ignored
    reader.push(new Uint8Array([0xb5, 0x62, 0x01, 0x07, 0x5c, 0x00])); // UBX noise
    reader.push(t.single + '\r\n');
    out.nmea = {
      count: fixes.length,
      first: fixes[0],
      second: fixes[1],
      badChecksums: reader.tok.badChecksums,
      latDM: parseLatLon('3348.00000', 'N'),
      lonDM: parseLatLon('11711.70000', 'W')
    };
    out.gga = buildGGA({ lat: 33.8, lon: -117.195, quality: 4, sats: 18, hdop: 0.6, alt: 120.5, geoidSep: -33.2 });

    // ---- sourcetable + RTCM framing ----
    const table = parseSourcetable(t.sourcetable);
    const types = [];
    const framer = new RtcmFramer(ty => types.push(ty));
    framer.push(new Uint8Array(t.rtcm));
    out.ntrip = {
      mounts: table.map(e => e.mount),
      needsGga: table.map(e => e.needsGga),
      format: table[0].format,
      types,
      km: Math.round(casterDistanceKm(table[0], 33.80, -117.20))
    };
    return out;
  }, texts);

  // LandXML
  ok('LandXML detected as grid coordinates', r.lx.crs === 'grid');
  ok('LandXML units read as feet', r.lx.unit === 'foot', r.lx.unit);
  ok('alignment name kept', r.lx.name === 'MAIN ST', r.lx.name);
  ok('staStart read', r.lx.staStart === 1000);
  ok('station equation read', r.lx.eq.length === 1 && r.lx.eq[0].dist === 500 && r.lx.eq[0].ahead === 2000, JSON.stringify(r.lx.eq));
  ok('no reconstruction warnings', r.lx.warnings.length === 0, JSON.stringify(r.lx.warnings));
  near('line+spiral+curve length', r.lx.length, EXP.landxml.totalFt, 0.01);
  near('station at BOA', r.lx.staAt0, 1000, 1e-9);
  near('station at EOA (equation applied)', r.lx.staAtEnd, EXP.landxml.endStationWithEq, 0.01);
  near('point at 500 ft is the spiral TS · E', r.lx.ptAt500.x, 10500, 0.01);
  near('point at 500 ft is the spiral TS · N', r.lx.ptAt500.y, 5000, 0.01);
  near('station 12+50 is 250 ft along', r.lx.distAt1250, 250, 1e-9);
  near('projected station', r.lx.proj.station, 1250, 0.01);
  near('projected offset is 10 right', r.lx.proj.offsetDisplay, 10, 0.01);
  ok('projection lands on the line', r.lx.proj.onLine === true);
  near('centreline bearing due east', r.lx.proj.bearing, 90, 0.01);

  // DXF
  ok('DXF units from $INSUNITS', r.dxf.unit === 'foot', r.dxf.unit);
  ok('DXF gives grid coordinates', r.dxf.crs === 'grid');
  ok('DXF found both entities', r.dxf.nLines === 2, String(r.dxf.nLines));
  ok('longest line offered first', /LWPOLYLINE/.test(r.dxf.first), r.dxf.first);
  near('LWPOLYLINE with bulge length', r.dxf.length, EXP.dxf.totalFt, 0.05);

  // GPX / CSV
  ok('GPX track name', r.gpx.name === 'HAUL ROAD', r.gpx.name);
  near('GPX length vs WGS-84 parallel arc (m)', r.gpx.length, EXP.gpx.lengthM, 0.05);
  ok('CSV read as lat/lon', r.csv.crs === 'geographic');
  ok('CSV rows', r.csv.pts === EXP.csv.points && r.csv.n === 3, JSON.stringify(r.csv));

  // formatting
  ok('formatStation 29+85.40', r.fmt.a === '29+85.40', r.fmt.a);
  ok('formatStation 12+50.00', r.fmt.b === '12+50.00', r.fmt.b);
  ok('rounding rolls up to 1+00.00', r.fmt.c === '1+00.00', r.fmt.c);
  ok('metric 1+250.25', r.fmt.d === '1+250.25', r.fmt.d);
  ok('parseStation 12+50.25', r.fmt.e === 1250.25, String(r.fmt.e));
  ok('parseStation plain number', r.fmt.f === 1250.25, String(r.fmt.f));
  ok('offset right', r.fmt.g === '10.00 ft RT', r.fmt.g);
  ok('offset left', r.fmt.h === '3.50 ft LT', r.fmt.h);
  ok('quadrant bearing east', r.fmt.i === 'N 90°00\'00" E', r.fmt.i);
  ok('quadrant bearing SE', r.fmt.j === 'S 45°00\'00" E', r.fmt.j);
  ok('seconds carry instead of 59\'60"', r.fmt.k === 'N 90°00\'00" E', r.fmt.k);
  ok('compact bearing for the tile', r.fmt.l === 'N 45°30\' E', r.fmt.l);
  ok('simplify drops collinear noise', r.simplify.after === 2, String(r.simplify.after));

  // NMEA
  console.log('\n— receiver —');
  ok('two valid fixes, the corrupt one dropped', r.nmea.count === 2, String(r.nmea.count));
  ok('bad checksum counted', r.nmea.badChecksums === 1, String(r.nmea.badChecksums));
  near('latitude from ddmm.mmmm', r.nmea.latDM, 33.8, 1e-9);
  near('longitude from dddmm.mmmm', r.nmea.lonDM, -117.195, 1e-9);
  ok('RTK fixed recognised', r.nmea.first.qualityLabel === 'RTK FIX', r.nmea.first.qualityLabel);
  near('satellite count', r.nmea.first.sats, 18, 0);
  near('age of corrections', r.nmea.first.ageOfDiff, 1.2, 1e-9);
  ok('base id kept', r.nmea.first.baseId === '0123', String(r.nmea.first.baseId));
  near('orthometric height', r.nmea.first.alt, 120.5, 1e-9);
  near('ellipsoidal height = orthometric + geoid separation', r.nmea.first.ellipsoidAlt, 87.3, 1e-9);
  near('accuracy from GST, not from HDOP', r.nmea.first.sigmaH, Math.hypot(0.008, 0.011), 1e-9);
  ok('accuracy is flagged as coming from GST', r.nmea.first.fromGst === true);
  ok('single-point fix labelled', r.nmea.second.qualityLabel === 'SINGLE', r.nmea.second.qualityLabel);
  ok('a stale GST does not make a single fix look centimetre-accurate',
     r.nmea.second.fromGst === false && r.nmea.second.sigmaH > 1, JSON.stringify({ g: r.nmea.second.fromGst, s: r.nmea.second.sigmaH }));
  near('fallback accuracy from HDOP', r.nmea.second.sigmaH, 2.4 * 3.0, 1e-9);
  ok('vertical sigma also dropped with the stale epoch', r.nmea.second.sigmaV == null, String(r.nmea.second.sigmaV));
  ok('UBX binary in the stream does not derail the parser', r.nmea.count === 2);
  ok('built GGA is well formed', /^\$GPGGA,\d{6}\.00,3348\.00000,N,11711\.70000,W,4,18,0\.6,120\.50,M,-33\.20,M,,\*[0-9A-F]{2}/.test(r.gga), r.gga);

  // sourcetable + RTCM
  ok('mountpoints parsed', r.ntrip.mounts.join() === 'NEAR,FAR', r.ntrip.mounts.join());
  ok('VRS mountpoint flagged as needing GGA', r.ntrip.needsGga[0] === true && r.ntrip.needsGga[1] === false, JSON.stringify(r.ntrip.needsGga));
  ok('mountpoint format read', r.ntrip.format === 'RTCM 3.2', r.ntrip.format);
  ok('distance to the base computed', r.ntrip.km >= 20 && r.ntrip.km <= 25, String(r.ntrip.km));
  ok('RTCM message types framed', r.ntrip.types.join() === '1005,1074', r.ntrip.types.join());

  /* ---------------- UI: GPX end to end ---------------- */
  console.log('\n— UI: geographic file —');
  await page.click('.tab[data-tab="project"]');
  await page.setInputFiles('#fileInput', path.join(FIX, 'track.gpx'));
  await page.waitForFunction(() => document.getElementById('fileMsg').textContent.includes('GPX'));
  ok('file message reports GPX + lat/lon', (await page.textContent('#fileMsg')).includes('latitude'));
  ok('georeference block hidden for lat/lon files', await page.isHidden('#georefBlock'));

  await ctx.setGeolocation({ latitude: 33.8001, longitude: -117.195, accuracy: 4 });
  await page.click('.tab[data-tab="track"]');
  await page.click('#btnGps');
  await page.waitForFunction(() => document.getElementById('staBig').textContent !== '—', null, { timeout: 10000 });
  const sta = await page.textContent('#staBig');
  const off = await page.textContent('#offBig');
  const half = EXP.gpx.lengthM / 2 / 0.3048;
  ok(`station near mid-track (${sta}, expected ~${half.toFixed(1)} ft)`,
     Math.abs(Number(sta.replace('+', '')) - half) < 3, sta);
  ok(`offset reads left of an eastbound line (${off})`, /LT/.test(off), off);
  await page.click('#btnMark');
  ok('mark logged', (await page.textContent('#logCount')) === '1');

  await page.click('.tab[data-tab="log"]');
  ok('log row shows the station', (await page.textContent('#logList')).includes(sta.trim()));
  await page.click('.tab[data-tab="track"]');
  await page.screenshot({ path: path.join(__dirname, 'shot-track-gpx.png') });

  /* ---------------- UI: external receiver ---------------- */
  console.log('\n— UI: RTK receiver ---');
  await page.click('.tab[data-tab="rover"]');
  await page.click('#srcSeg .seg-btn[data-source="rover"]');
  ok('receiver panel shown', await page.isVisible('#roverBlock'));

  const feed = async (...sentences) => {
    await page.evaluate(lines => window.stationDebug.feedNmea(lines.join('\r\n') + '\r\n'), sentences);
    await page.waitForTimeout(150);
  };
  await feed(texts.gst, texts.gga);

  ok('rover stats appear', await page.isVisible('#roverStats'));
  ok('solution reads RTK FIX', (await page.textContent('#sQuality')).includes('RTK FIX'), await page.textContent('#sQuality'));
  ok('sigma shown in centimetres', /1\.4 cm/.test(await page.textContent('#sSigmaH')), await page.textContent('#sSigmaH'));
  ok('corrections age shown', (await page.textContent('#sAge')).startsWith('1.2'), await page.textContent('#sAge'));
  ok('ellipsoid height shown', (await page.textContent('#sEllip')).startsWith('87.3'), await page.textContent('#sEllip'));

  await page.click('.tab[data-tab="track"]');
  const rSta = await page.textContent('#staBig');
  ok(`rover drives the station readout (${rSta})`, rSta.trim() === sta.trim(), `${rSta} vs ${sta}`);
  ok('fix badge reads RTK FIX', (await page.textContent('#fixBadge')).trim() === 'RTK FIX', await page.textContent('#fixBadge'));
  ok('offset is on the centreline', /ON|0\.0\d ft/.test(await page.textContent('#offBig')), await page.textContent('#offBig'));
  ok('accuracy tile in centimetres', /±1\.4 cm/.test(await page.textContent('#tAcc')), await page.textContent('#tAcc'));
  ok('satellite tile', (await page.textContent('#tSats')) === '18', await page.textContent('#tSats'));
  const el0 = await page.textContent('#elBig');
  ok(`elevation from the receiver (${el0})`, /EL 395\.3\d ft/.test(el0), el0);

  // rod height comes off the elevation
  await page.click('.tab[data-tab="rover"]');
  await page.fill('#inpAntenna', '2');
  await page.dispatchEvent('#inpAntenna', 'change');
  await feed(texts.gga);
  await page.click('.tab[data-tab="track"]');
  const el1 = await page.textContent('#elBig');
  ok(`rod height subtracted (${el1})`, /EL 393\.3\d ft/.test(el1) && /rod 2 ft/.test(el1), el1);

  await page.fill('#markNote', 'hub & tack');
  await page.click('#btnMark');
  ok('rover mark logged', (await page.textContent('#logCount')) === '2');
  await page.click('.tab[data-tab="log"]');
  const logText = await page.textContent('#logList');
  ok('mark records the fix quality', logText.includes('RTK FIX'), logText.slice(0, 160));
  ok('mark records the elevation', /EL 393\.3/.test(logText), logText.slice(0, 200));
  await page.click('.tab[data-tab="track"]');

  // corrections dropping out must be visible, not silent
  await feed(texts.single);
  const warnText = await page.textContent('#staWarn');
  ok(`losing RTK is called out (${warnText.slice(0, 60)})`, /corrections are not reaching/i.test(warnText), warnText);
  ok('badge falls back to SINGLE', (await page.textContent('#fixBadge')).trim() === 'SINGLE', await page.textContent('#fixBadge'));
  await page.screenshot({ path: path.join(__dirname, 'shot-rover.png') });

  // back to the phone for the rest of the run
  await page.click('.tab[data-tab="rover"]');
  await page.click('#srcSeg .seg-btn[data-source="phone"]');
  await page.click('.tab[data-tab="track"]');
  ok('the rover reading does not linger after switching source',
     (await page.textContent('#staBig')).trim() === '—', await page.textContent('#staBig'));
  await page.click('#btnGps');
  await page.waitForFunction(() => document.getElementById('staBig').textContent !== '—', null, { timeout: 10000 });

  /* ---------------- UI: LandXML + georeferencing ---------------- */
  console.log('\n— UI: grid file + georeference —');
  await page.click('.tab[data-tab="project"]');
  await page.setInputFiles('#fileInput', path.join(FIX, 'alignment.xml'));
  await page.waitForFunction(() => document.getElementById('fileMsg').textContent.includes('LandXML'));
  ok('grid file shows the georeference step', await page.isVisible('#georefBlock'));
  ok('northing/easting inputs stay hidden in station mode', await page.isHidden('#srcGrid'));
  ok('units locked to the file', await page.isDisabled('#selUnit'));
  ok('summary shows the design stationing through the equation',
     /10\+00\.00 to 29\+85\.\d\d/.test(await page.textContent('#alignSummary')),
     await page.textContent('#alignSummary'));

  // Two control points, 500 ft apart, grid north = true north.
  const mpd = await page.evaluate(async () => (await import('./js/geo.js')).metresPerDegree(33.8));
  const lat0 = 33.8, lon0 = -117.2;
  const lon1 = lon0 + (500 * 0.3048) / mpd.lon;

  const addCtrl = async (staTxt, lat, lon) => {
    await page.fill('#cpSta', staTxt);
    await page.fill('#cpOff', '0');
    await page.fill('#cpLat', String(lat));
    await page.fill('#cpLon', String(lon));
    await page.click('#btnAddCtrl');
  };
  await addCtrl('10+00', lat0, lon0);
  await addCtrl('15+00', lat0, lon1);

  const fit = await page.textContent('#fitOut');
  ok('two control points solved', /Georeferenced from 2 points/.test(fit), fit);
  const scale = Number((fit.match(/scale ([\d.]+)/) || [])[1]);
  near('fitted scale is the foot', scale, 0.3048, 2e-5);
  const rot = Number((fit.match(/rotated (-?[\d.]+)°/) || [])[1]);
  near('fitted rotation ~0°', rot, 0, 0.01);
  const rms = Number((fit.match(/RMS residual ([\d.]+)/) || [])[1]);
  ok(`RMS residual under 0.01 ft (${rms})`, rms < 0.01);

  // Stand on the first control point: it should read 10+00.00 on the centreline.
  await ctx.setGeolocation({ latitude: lat0, longitude: lon0, accuracy: 3 });
  await page.click('.tab[data-tab="track"]');
  await page.waitForFunction(() => /^\d+\+/.test(document.getElementById('staBig').textContent), null, { timeout: 10000 });
  await page.waitForTimeout(1200);
  const sta2 = await page.textContent('#staBig');
  const off2 = await page.textContent('#offBig');
  ok(`reads 10+00 at the control point (${sta2})`, /^10\+0[01]/.test(sta2.trim()), sta2);
  ok(`offset on centreline (${off2})`, /ON|0\.0\d ft/.test(off2), off2);

  // target station
  await page.fill('#targetSta', '12+50');
  await page.waitForTimeout(300);
  const tgt = await page.textContent('#targetOut');
  ok(`go-to-station reads ahead ~250 ft (${tgt})`, /AHEAD 2[45]\d\.\d/.test(tgt), tgt);

  // persistence across a reload
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  ok('project restored after reload', (await page.textContent('#projectName')).includes('MAIN ST'),
     await page.textContent('#projectName'));
  ok('marks restored after reload', (await page.textContent('#logCount')) === '2');

  await page.click('#chkDemo');
  await page.waitForTimeout(1200);
  ok('demo walk moves the readout', /^\d+\+/.test((await page.textContent('#staBig')).trim()));
  await page.screenshot({ path: path.join(__dirname, 'shot-track-landxml.png') });
  await page.click('.tab[data-tab="project"]');
  await page.screenshot({ path: path.join(__dirname, 'shot-project.png'), fullPage: true });

  /* ---------------- native shell contract ---------------- */
  console.log('\n— Android shell (mock bridge) —');
  const nctx = await browser.newContext({
    permissions: ['geolocation'],
    geolocation: { latitude: 33.8, longitude: -117.195, accuracy: 4 },
    viewport: { width: 430, height: 932 }
  });
  // Installed before any app module runs, exactly as the WebView injects it.
  await nctx.addInitScript(() => {
    const emit = o => window.AndroidStationEvent && window.AndroidStationEvent(JSON.stringify(o));
    window.__mock = { written: [], ntrip: null, connects: [] };
    window.AndroidStation = {
      appInfo: () => JSON.stringify({ ok: true, version: '1.0', android: 34, model: 'Pixel' }),
      listTransports: () => JSON.stringify({ ok: true, transports: ['usb', 'spp', 'ble'] }),
      listDevices: kind => JSON.stringify({
        ok: true,
        devices: kind === 'spp'
          ? [{ id: 'AA:BB:CC', name: 'ArduSimple BT', detail: 'paired · AA:BB:CC' }]
          : [{ id: 'usb1', name: 'u-blox GNSS receiver', detail: 'u-blox · 1546:01a9' }]
      }),
      connect: json => {
        const o = JSON.parse(json);
        window.__mock.connects.push(o);
        setTimeout(() => emit({ type: 'status', state: 'connected', name: 'u-blox GNSS receiver', kind: o.kind, detail: 'u-blox GNSS receiver · USB ' + o.baudRate }), 10);
        return JSON.stringify({ ok: true, pending: true });
      },
      write: b64 => { window.__mock.written.push(b64); return JSON.stringify({ ok: true }); },
      disconnect: () => JSON.stringify({ ok: true }),
      sourcetable: json => {
        const o = JSON.parse(json);
        setTimeout(() => emit({
          type: 'sourcetable', requestId: o.requestId, ok: true,
          text: 'STR;VRS_RTCM32;Network;RTCM 3.2;1005(1),1074(1);2;GPS+GLO;NET;USA;33.90;-117.40;1;0;sNTRIP;none;B;N;9600;'
        }), 10);
        return JSON.stringify({ ok: true, pending: true });
      },
      ntripConnect: json => {
        window.__mock.ntrip = JSON.parse(json);
        setTimeout(() => {
          emit({ type: 'ntrip', state: 'on', mount: window.__mock.ntrip.mount });
          emit({ type: 'ntripStats', bytes: 4096, lastDataAt: Date.now(), types: [[1005, 2], [1074, 12]] });
        }, 10);
        return JSON.stringify({ ok: true, pending: true });
      },
      ntripDisconnect: () => JSON.stringify({ ok: true }),
      _nmea: text => emit({ type: 'data', b64: btoa(text) })
    };
  });
  const np = await nctx.newPage();
  const nerrors = [];
  np.on('pageerror', e => nerrors.push('pageerror: ' + e.message));
  await np.goto(BASE, { waitUntil: 'networkidle' });

  await np.click('.tab[data-tab="project"]');
  await np.setInputFiles('#fileInput', path.join(FIX, 'track.gpx'));
  await np.waitForFunction(() => document.getElementById('fileMsg').textContent.includes('GPX'));
  await np.click('.tab[data-tab="rover"]');
  await np.click('#srcSeg .seg-btn[data-source="rover"]');

  ok('the app knows it is running natively', (await np.textContent('#sourceNote')).includes('Android app'),
     await np.textContent('#sourceNote'));
  ok('paired-Bluetooth option appears', await np.isVisible('#btnSpp'));
  ok('desktop serial option is hidden', await np.isHidden('#btnSerial'));
  const ntripNote = await np.textContent('#ntripNote');
  ok('the relay wording is replaced', /no relay/.test(ntripNote) && !/this site's relay/.test(ntripNote), ntripNote);

  await np.click('#btnUsb');
  await np.waitForFunction(() => document.getElementById('roverMsg').textContent.includes('Connected'), null, { timeout: 8000 });
  ok('a single device connects without a picker', (await np.textContent('#roverMsg')).includes('u-blox'),
     await np.textContent('#roverMsg'));
  const connectArgs = await np.evaluate(() => window.__mock.connects[0]);
  ok('the device id and baud rate are passed through',
     connectArgs.kind === 'usb' && connectArgs.id === 'usb1' && connectArgs.baudRate === 38400, JSON.stringify(connectArgs));

  await np.evaluate(([g, s]) => { window.AndroidStation._nmea(s + '\r\n' + g + '\r\n'); }, [texts.gga, texts.gst]);
  await np.waitForTimeout(200);
  ok('NMEA from the shell drives the fix', (await np.textContent('#sQuality')).includes('RTK FIX'),
     await np.textContent('#sQuality'));
  await np.click('.tab[data-tab="track"]');
  ok('station reads through the native link', /^\d+\+\d/.test((await np.textContent('#staBig')).trim()),
     await np.textContent('#staBig'));
  await np.click('.tab[data-tab="rover"]');

  await np.fill('#ntHost', 'rtk.example.com');
  await np.fill('#ntUser', 'crew14');
  await np.fill('#ntPass', 'secret');
  await np.click('#btnMounts');
  await np.waitForFunction(() => document.getElementById('mountTable').children.length > 0, null, { timeout: 8000 });
  ok('mountpoints come back through the shell', (await np.textContent('#mountTable')).includes('VRS_RTCM32'),
     await np.textContent('#mountTable'));
  ok('the VRS mountpoint is flagged', (await np.textContent('#mountTable')).includes('VRS'));

  await np.click('#mountTable .linerow');
  await np.click('#btnNtrip');
  await np.waitForFunction(() => document.getElementById('nState').textContent.includes('streaming'), null, { timeout: 8000 });
  ok('corrections report as streaming', (await np.textContent('#nState')).includes('VRS_RTCM32'),
     await np.textContent('#nState'));
  await np.waitForFunction(() => document.getElementById('nTypes').textContent.includes('1074'), null, { timeout: 5000 });
  ok('RTCM message types are shown', (await np.textContent('#nTypes')).includes('1005'),
     await np.textContent('#nTypes'));
  ok('correction volume is shown', /kB|B/.test(await np.textContent('#nBytes')), await np.textContent('#nBytes'));
  const passed = await np.evaluate(() => window.__mock.ntrip);
  ok('caster credentials reach the shell', passed.user === 'crew14' && passed.pass === 'secret' && passed.mount === 'VRS_RTCM32',
     JSON.stringify({ ...passed, pass: '***' }));

  // The whole point of the native path: corrections do not come back through
  // the page to be forwarded byte by byte.
  const written = await np.evaluate(() => window.__mock.written.length);
  ok('RTCM is not round-tripped through the page', written === 0, `${written} writes`);
  ok('no page errors in the native shell', nerrors.length === 0, nerrors.join(' | '));
  await np.screenshot({ path: path.join(__dirname, 'shot-native.png'), fullPage: true });
  await nctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
