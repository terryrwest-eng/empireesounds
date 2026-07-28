// Builds test fixtures with independently-derived geometry, and prints the
// expected answers so the browser test can assert against them.
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

/* ---- LandXML: line -> spiral -> curve, feet, staStart 1000 ---- */

const R = 500, LS = 200;
const theta = LS / (2 * R);                       // total spiral deflection (rad)
// Classic clothoid series (a different derivation than the app's numeric integration)
const X = LS * (1 - theta ** 2 / 10 + theta ** 4 / 216 - theta ** 6 / 9360);
const Y = LS * (theta / 3 - theta ** 3 / 42 + theta ** 5 / 1320 - theta ** 7 / 75600);

const lineStart = [10000, 5000];                  // [E, N]
const lineEnd = [10500, 5000];
const spiralEnd = [lineEnd[0] + X, lineEnd[1] + Y];

const tan = [Math.cos(theta), Math.sin(theta)];
const leftN = [-tan[1], tan[0]];
const centre = [spiralEnd[0] + R * leftN[0], spiralEnd[1] + R * leftN[1]];
const rel = [spiralEnd[0] - centre[0], spiralEnd[1] - centre[1]];
const curveEnd = [centre[0] - rel[1], centre[1] + rel[0]];   // +90° ccw
const curveLen = Math.PI / 2 * R;

const lineLen = 500;
const total = lineLen + LS + curveLen;
const p = (e, n) => `${n.toFixed(6)} ${e.toFixed(6)}`;      // LandXML is "north east"

fs.writeFileSync(path.join(OUT, 'alignment.xml'), `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Imperial linearUnit="foot" areaUnit="squareFoot" volumeUnit="cubicFeet" temperatureUnit="fahrenheit" pressureUnit="inHG"/></Units>
  <Alignments name="Test">
    <Alignment name="MAIN ST" staStart="1000" length="${total.toFixed(6)}">
      <CoordGeom>
        <Line length="${lineLen}"><Start>${p(...lineStart)}</Start><End>${p(...lineEnd)}</End></Line>
        <Spiral length="${LS}" radiusStart="INF" radiusEnd="${R}" rot="ccw" spiType="clothoid">
          <Start>${p(...lineEnd)}</Start><End>${p(...spiralEnd)}</End>
        </Spiral>
        <Curve rot="ccw" radius="${R}" length="${curveLen.toFixed(6)}">
          <Start>${p(...spiralEnd)}</Start><Center>${p(...centre)}</Center><End>${p(...curveEnd)}</End>
        </Curve>
      </CoordGeom>
      <StaEquation staInternal="${(1000 + lineLen).toFixed(6)}" staAhead="2000" staBack="1500"/>
    </Alignment>
  </Alignments>
</LandXML>
`);

/* ---- DXF: LWPOLYLINE, 100 ft tangent then a 90° arc of R=100 ---- */

const dxfLen = 100 + Math.PI / 2 * 100;
const bulge = Math.tan(Math.PI / 2 / 4);
fs.writeFileSync(path.join(OUT, 'plan.dxf'), [
  0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 2, 0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LWPOLYLINE', 8, 'CL-ROAD', 90, 3, 70, 0,
  10, 0, 20, 0,
  10, 100, 20, 0, 42, bulge.toFixed(9),
  10, 200, 20, 100,
  0, 'LINE', 8, 'DITCH', 10, 0, 20, 40, 11, 60, 21, 40,
  0, 'ENDSEC', 0, 'EOF', ''
].join('\n'));

/* ---- GPX: two points along a parallel of latitude ---- */

const lat = 33.8, lon0 = -117.2, lon1 = -117.19;
fs.writeFileSync(path.join(OUT, 'track.gpx'), `<?xml version="1.0"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>HAUL ROAD</name><trkseg>
    <trkpt lat="${lat}" lon="${lon0}"/><trkpt lat="${lat}" lon="${lon1}"/>
  </trkseg></trk>
</gpx>
`);

/* ---- CSV: lat/lon with a header ---- */

fs.writeFileSync(path.join(OUT, 'points.csv'),
  'name,lat,lon\nBOA,33.8,-117.2\nMID,33.8,-117.195\nEOA,33.8,-117.19\n');

/* ---- expected values ---- */

// Arc along the WGS-84 parallel: N(φ)·cosφ·Δλ. (A spherical haversine is ~0.2%
// short at this latitude, so it is the wrong yardstick for a tangent plane.)
const r = Math.PI / 180;
const parallelArc = (latDeg, dLonDeg) => {
  const a = 6378137, f = 1 / 298.257223563, e2 = 2 * f - f * f;
  const p = latDeg * r;
  const N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return N * Math.cos(p) * dLonDeg * r;
};

const expected = {
  landxml: {
    totalFt: total,
    endStation: 1000 + total,
    // with the equation at 500 ft along: station jumps to 2000
    endStationWithEq: 2000 + (total - lineLen),
    spiralEnd, curveEnd, centre
  },
  dxf: { totalFt: dxfLen },
  gpx: { lengthM: parallelArc(lat, lon1 - lon0) },
  csv: { points: 3 }
};
fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify(expected, null, 2));
console.log(JSON.stringify(expected, null, 2));
