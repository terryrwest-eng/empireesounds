# Station

A GPS stationing app for field crews, in the same spirit as OnStation: load the
alignment for the job, and the phone tells you what station you are standing at,
and how far off centreline, anywhere on the project.

Works off the phone's own GPS, or off an RTK receiver over USB or Bluetooth with
corrections from an NTRIP caster.

Runs at `/station/` on the same server as the rest of the site. No build step, no
framework, no dependencies. The alignment file never leaves the device; the only
thing the server does is relay NTRIP corrections, which a browser cannot fetch
for itself.

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

## Using an RTK receiver

The phone's own GPS is the fallback, not the point. Connect a real receiver —
an ArduSimple simpleRTK2B or anything else that speaks NMEA — and the station
readout is as good as the fix behind it.

**Getting the receiver in:**

| Link | Works on | Notes |
|---|---|---|
| **USB (WebUSB)** | Android Chrome, desktop Chrome/Edge | An OTG cable to the board's USB port. The ZED-F9P's native USB is a CDC serial port, so it connects directly. The steadiest link, and it powers the board. |
| **Bluetooth LE** | Android Chrome, desktop Chrome/Edge | Nordic UART, u-blox SPS, HM-10 and Feasycom serial profiles. **Classic Bluetooth SPP — the XBee-socket Bluetooth module — cannot be reached by any browser**, because pairing happens at the OS level. That module works in SurPad and will not work here; use the cable or a BLE module. |
| **Serial port** | Desktop Chrome/Edge | For a laptop on the tailgate. |
| **Nothing at all** | iPhone / iPad | iOS has no WebUSB, Web Serial or Web Bluetooth in any browser, Safari or otherwise. On iOS this app is limited to the phone's GPS unless it is wrapped as a native app. |

What is read from the receiver: position, fix quality (RTK fixed / float / DGPS /
single), satellite count, HDOP and PDOP, age of corrections, base station ID,
and — when the receiver sends GST — the actual 1σ horizontal and vertical
accuracy, which is what the readout displays. A GST is only believed for the
epoch it was sent for, so a solution that drops out of RTK stops claiming
centimetres immediately.

**Rod height** is subtracted from the receiver's height, so the elevation shown
is the ground, not the antenna.

## Corrections (NTRIP)

Enter the caster, pull the mountpoint list, pick one — nearest base first if the
receiver already has a position — and connect. Corrections stream down and go
straight out to the receiver over the same link it is connected on. VRS and
nearest-base mountpoints get the rover's GGA pushed back up every ten seconds
automatically, and the mountpoint list marks which ones need it.

A browser cannot open a TCP socket, so this goes through a relay built into
`server.js`:

```
GET  /ntrip/sourcetable?host=&port=[&tls=1]
GET  /ntrip/stream?host=&port=&mount=&session=
POST /ntrip/gga?session=
GET  /ntrip/status
```

It is a dumb pipe with no accounts and no storage. Credentials travel in an
`X-Ntrip-Auth` header rather than the URL, so they cannot land in an access log,
and they are forwarded to the caster and then forgotten. The caster password is
kept in the browser only if you tick the box.

Because a relay that will open a socket to anywhere is a liability, it is
fenced:

- hostnames must resolve to public addresses — private, loopback, CGNAT and
  link-local ranges are refused, so it cannot be used to reach inside the
  network it runs on
- ports are limited to 2101–2199 plus 80/443/8080/8000
- eight concurrent sessions, sixty-second idle timeout
- TLS casters supported with `tls=1`

| Env var | Default | |
|---|---|---|
| `NTRIP_RELAY` | `on` | `off` disables the relay entirely |
| `NTRIP_HOSTS` | — | comma-separated allowlist; if set, nothing else is reachable |
| `NTRIP_MAX_SESSIONS` | `8` | concurrent streams |
| `NTRIP_PORTS` | — | extra permitted ports |
| `NTRIP_IDLE_MS` | `60000` | drop a stream that goes quiet |

If the receiver already handles its own corrections — an ESP32 WiFi NTRIP
Master, or a base radio — leave the NTRIP section empty. The app just reads the
resulting fix.

### A note on datums

RTK gives a position in the caster's datum — usually NAD83(2011) from a US CORS
network — while the plan is on a state plane grid. The two-point localization
absorbs the difference between them along with the grid scale factor, which is
exactly why it is done against control you can stand on rather than by naming a
projection. Occupy two points you trust, and check the RMS residual before
believing anything.

## In the field

- **Station and offset**, large, pinned to the top of the screen. Offsets are
  signed the way plans call them: **+ right, − left**, looking up-station.
- **Go to station** — type `12+50` and it counts down the distance ahead or back.
- **Marks** — station, offset, lat/lon, elevation, fix quality, satellites, σ,
  age of corrections and a note, exported as CSV or GeoJSON. The quality of the
  fix is part of the record, because a staking note that cannot be checked later
  is not worth much.
- **Plan view** — the centreline with station ticks, your position, accuracy
  circle and the perpendicular tie back to the centreline. Pinch, drag, follow.
- **Demo walk** — simulates a position moving up the alignment, for checking a
  file at the office.
- Installs to the home screen and works offline; the project is saved on the
  device.

On phone GPS, a few metres is the best you will see — enough to know which
station you are at, not enough to set one. On an RTK fix from a real receiver
the readout is centimetre-level, and the accuracy shown is the receiver's own,
not a guess.

This is a stationing tool, not a replacement for SurPad: there is no coordinate
system library, no point staking, no codes and linework, no raw data file.

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
js/nmea.js      NMEA reader — fix quality, accuracy, corrections age
js/rover.js     WebUSB / Web Serial / Web Bluetooth links to a receiver
js/ntrip.js     NTRIP client, sourcetable, RTCM framing
js/map.js       canvas plan view
js/app.js       wiring, GPS, georeferencing UI, log
test/run.js     browser test suite
test/relay.js   NTRIP relay tests, against a fake caster
../ntrip-relay.js  the relay itself, mounted by server.js
```

## Tests

Geometry, parsing and the UI are covered end to end in a real browser. Needs
playwright:

```
npm i -D playwright && npx playwright install chromium
npm run test:station
```

The relay half (`station/test/relay.js`) needs no browser: it stands up a fake
NTRIP caster on localhost and checks the stream, the GGA push, the 401 path, and
that the SSRF guard really is on by default.

Fixtures are generated with independently derived geometry — a clothoid built
from the classic series expansion, an arc length from first principles, a
parallel arc on the WGS-84 ellipsoid — so the assertions check the app's maths
rather than repeat it.
