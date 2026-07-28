# Station for Android

The native app. Same stationing engine as the web version — it *is* the web
version, bundled into the APK — with Android underneath it holding the hardware.

That split is deliberate. All the surveying (LandXML curves and spirals, DXF,
stationing, offsets, localization, the plan view) stays in the code that has
tests around it, and Kotlin only does what a browser cannot:

| | Browser | This app |
|---|---|---|
| USB receiver | WebUSB, CDC only | Any Android USB serial device — CDC-ACM, CP210x, CH34x, FTDI, PL2303 |
| **Classic Bluetooth (SPP)** | **impossible** | **works — the module SurPad pairs with** |
| Bluetooth LE | yes | yes |
| NTRIP caster | needs a server relay; browsers cannot open TCP | direct TCP to the caster, TLS optional, any port |
| Screen off | link drops | foreground service keeps it up all shift |
| iOS | no hardware access at all | not applicable |

## Building it

Needs Android Studio, or just the command line tools and a JDK 17+.

```
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Gradle pulls the Android plugin, AndroidX and the USB serial driver on the first
run, so that build needs a network. Everything after is offline.

`app/build.gradle.kts` copies `../station` into the APK's assets at build time —
edit the web app, rebuild, and the phone gets it. There is no second copy of
anything to keep in sync.

For a release build, add your own signing config and run `assembleRelease`.

## How it fits together

```
MainActivity          WebView over the bundled app, served from an https origin
                      by WebViewAssetLoader so localStorage and geolocation work
StationBridge         the @JavascriptInterface surface; every method returns at
                      once and reports back as an event, so the readout never
                      blocks on hardware
Rig                   the one place that knows what is connected; also pulls the
                      latest good GGA out of the NMEA stream for VRS casters
UsbSerialTransport    USB, via usb-serial-for-android
SppTransport          classic Bluetooth serial, with the channel-1 fallback that
                      cheap modules need
BleTransport          serial over BLE: Nordic UART, u-blox SPS, HM-10
NtripClient           TCP to the caster, NTRIP 1 or 2, GGA upload, backoff retry
StationService        foreground service + wake lock
```

The JavaScript half of the contract is `station/js/native.js`, and it is
documented at the top of that file. It is covered by tests: `station/test/run.js`
installs a mock `AndroidStation` bridge and drives the whole flow — connect,
NMEA in, mountpoint list, corrections streaming — against it.

### Corrections do not pass through the page

The caster socket lives in Kotlin and writes RTCM straight to the receiver's
serial port. Nothing is marshalled through JavaScript, so a busy page cannot
stall a correction stream, and it keeps running with the screen off. The page is
only told how many bytes arrived and which RTCM messages they were, for the
diagnostics panel.

## Connecting a receiver

**USB.** OTG cable to the receiver's USB port. Android asks for permission the
first time; plugging it in with the app closed offers to open Station.

**Classic Bluetooth.** Pair the module in Android settings first, then choose
*Bluetooth (paired)*. This is the XBee-socket Bluetooth module on an ArduSimple —
the one no browser can reach.

**BLE.** *Bluetooth (BLE)* scans for eight seconds and lists what it finds.

If more than one device is attached or paired, the app lists them; if there is
only one, it connects straight to it.

## Corrections

Caster host, port, mountpoint, username, password. *Get mountpoints* pulls the
sourcetable and sorts it by distance from wherever the receiver currently thinks
it is. Anything that speaks NTRIP works the same way — a paid subscription
network, a state CORS system, RTK2go — and VRS mountpoints get the rover's GGA
pushed up every ten seconds without being asked.

TLS casters: tick the TLS box. There is no port restriction here; the phone is
dialling out on its own behalf, not through a shared relay.

## What is not verified

Everything in `station/` is covered by the test suite. The Kotlin is not — there
is no Android SDK or device in the environment it was written in. It parses
clean, and it is deliberately plain, but the first run on real hardware is the
first real test. The likeliest places for trouble, in order: the USB permission
round trip, the BLE notification descriptor on a particular module, and the
NTRIP 1 handshake against a caster that ends its header differently from the
ones this was written against.
