# Station

A GPS stationing app for field crews, in the same spirit as OnStation: load the
alignment for the job, and the phone tells you what station you are standing at,
and how far off centreline, anywhere on the project.

Runs at `/station/` on the same server as the rest of the site. No build step, no
framework, no dependencies, no backend — the alignment file never leaves the
phone.

## What it reads

| Format | Coordinates | Notes |
|---|---|---|
| **LandXML** (`.xml`) | project grid | `<Alignment>` with its own `staStart` and station equations. Lines, circular curves and clothoid spirals are rebuilt to a 1 mm chord tolerance. |
| **DXF** (`.dxf`) | drawing grid | ASCII DXF. LWPOLYLINE (bulges included), POLYLINE/VERTEX, LINE, ARC, and SPLINE by its fit points. Units read from `$INSUNITS`. Geometry inside blocks is not read — explode it first. |
| **KML / KMZ** | lat / lon | Placemark lines and points. KMZ is unzipped in the browser. |
| **GPX** | lat / lon | Tracks, routes and waypoints. |
| **GeoJSON** | lat / lon | LineString, MultiLineString, Polygon rings, Points. |
| **CSV / point file** | either | Headers like `lat,lon` or `northing,easting`, or a headerless PNEZD point file. |

If a file holds several lines, you pick which one is the centreline. Everything
else (ditch lines, edge of pavement, parcel boundaries) is offered too, so the
same file can be re-used for a different feature.

## Georeferencing

Lat/lon files are ready the moment they load. A grid file — LandXML, DXF, a
northing/easting point file — has no idea where on Earth it is, so it has to be
tied down first:

1. Stand on something you know the station of, or know the coordinates of.
2. Add a control point: either **station + offset** (the app solves the grid
   coordinates from the alignment itself) or a typed **northing / easting**.
3. Give it a latitude and longitude — typed, or captured from the GPS.
4. Do it again somewhere else on the job.

Two points solve a 2D similarity — translation, rotation and scale — which
absorbs both the grid-to-ground scale factor and the convergence between grid
north and true north. The RMS residual is shown so you can see whether the
control agrees with itself; if it is metres, one of the points is wrong. One
control point will work in a pinch, but it has to assume grid north is true north
and take the scale from the file's units, which is rarely exactly right.

Stationing on a grid file is measured in the file's own units along the file's
own geometry, so it matches the plan rather than the ground.

## In the field

- **Station and offset**, large, pinned to the top of the screen. Offsets are
  signed the way plans call them: **+ right, − left**, looking up-station.
- **Go to station** — type `12+50` and it counts down the distance ahead or back.
- **Marks** — station, offset, lat/lon, accuracy and a note, exported as CSV or
  GeoJSON.
- **Plan view** — the centreline with station ticks, your position, accuracy
  circle and the perpendicular tie back to the centreline. Pinch, drag, follow.
- **Demo walk** — simulates a position moving up the alignment, for checking a
  file at the office.
- Installs to the home screen and works offline; the project is saved on the
  device.

A phone's GPS is a few metres at best. That is enough to know which station you
are at and to find a stake; it is not a rover and it will not set one.

## Layout

```
index.html      app shell
app.css
sw.js           offline cache
manifest.webmanifest, icon.svg, icon-maskable.svg
js/geo.js       local tangent plane, bearings, similarity fit
js/alignment.js stationing, projection, station formatting
js/parse.js     format dispatch + GeoJSON / GPX / KML / KMZ / CSV
js/landxml.js   LandXML alignments, curves and spirals
js/dxf.js       DXF entities
js/map.js       canvas plan view
js/app.js       wiring, GPS, georeferencing UI, log
test/run.js     browser test suite
```

## Tests

Geometry, parsing and the UI are covered end to end in a real browser. Needs
playwright:

```
npm i -D playwright && npx playwright install chromium
node station/test/run.js
```

Fixtures are generated with independently derived geometry — a clothoid built
from the classic series expansion, an arc length from first principles, a
parallel arc on the WGS-84 ellipsoid — so the assertions check the app's maths
rather than repeat it.
