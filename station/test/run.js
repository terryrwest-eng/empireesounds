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
const BASE = `http://localhost:${PORT}/station/`;

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
    csv: fs.readFileSync(path.join(FIX, 'points.csv'), 'utf8')
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
  ok('marks restored after reload', (await page.textContent('#logCount')) === '1');

  await page.click('#chkDemo');
  await page.waitForTimeout(1200);
  ok('demo walk moves the readout', /^\d+\+/.test((await page.textContent('#staBig')).trim()));
  await page.screenshot({ path: path.join(__dirname, 'shot-track-landxml.png') });
  await page.click('.tab[data-tab="project"]');
  await page.screenshot({ path: path.join(__dirname, 'shot-project.png'), fullPage: true });

  ok('no page errors', errors.length === 0, errors.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
