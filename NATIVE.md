# The native package

The web game is still a plain `index.html` that works from a double-click.
Nothing here changes that — this is the wrapper around it.

## Why bother

**Haptics on iOS.** `navigator.vibrate` does not exist in Safari; vibration is
not solvable there from the web at all. Wrapped by Capacitor, the Taptic Engine
is reachable through the Haptics plugin. That is the whole reason this exists —
landing feedback and the thrust rumble reaching an iPhone.

Two things come along for free: the browser cache can no longer serve a stale
build, and the app pins landscape so the "please rotate" gate never appears.

## Building it

```sh
npm install
npm run www            # collect what the app bundle needs into www/
npx cap sync           # copy it into the native projects
npm run ios            # www + sync + open Xcode
```

`www/` and `node_modules/` are generated and gitignored. `ios/` is committed —
Capacitor's own `.gitignore` in there keeps `Pods/` and the copied web assets
out, leaving about two dozen real project files.

Verified here: `xcodebuild ... -sdk iphonesimulator` succeeds and the app runs
in the simulator with no JavaScript errors.

**Not verified:** the haptics themselves. A simulator has no Taptic Engine, so
whether a landing actually feels right needs a physical device.

## How haptics are wired

The game speaks in named events, not vibration patterns, because the two
backends disagree about what a haptic even is:

| Event | Web (`navigator.vibrate`) | Native (Taptic Engine) |
|---|---|---|
| `landSoft` | `[18]` | impact `LIGHT` |
| `landHard` | `[55]` | impact `MEDIUM` |
| `crash` | `[60, 40, 120]` | notification `ERROR` |
| `penalty` | `[180]` | notification `WARNING` |
| `fuelWarn` | `[30, 70, 30]` | notification `WARNING` |
| `shout` | `[25, 50, 25]` | impact `LIGHT` |
| `rumble` | `220` | impact `HEAVY` |

The web column is exactly what the game shipped with, so the browser build is
unchanged. Neither backend has a sustained mode, so the thrust rumble re-issues
a pulse every 200 ms and lets the overlap read as one.

`window.Capacitor.Plugins.Haptics` is reached directly through the runtime
bridge rather than by importing `@capacitor/haptics`. The npm package is a
wrapper that would need a bundler, and this project has no build step; the
bridge exposes the same plugin without one.

## The web app

`manifest.webmanifest` and `sw.js` make the game installable and playable
offline. The caching is deliberately lopsided:

- **documents** — network first, cache only as a fallback
- **images, audio, icons** — cache first, refreshed behind the page

So an online player always runs the current build. This matters: a browser
holding an old `index.html` once made a fixed bug look unfixed for a whole
session, and a service worker is a much better cache than the one that did it.

`registerServiceWorker()` skips three cases: `file://` (no origin to scope to,
and it throws), inside Capacitor (the app is already served from the bundle),
and browsers without support.

## Icons

`node scripts/make-icons.js` draws them. No image library — the manifest wants
PNG, Node ships zlib, and the icon is six rectangles. The output is
byte-identical on every run, so regenerating does not show up as a diff.

## Server URL

Resolved in three steps, first match wins:

1. **`?server=`** — how the web build is pointed anywhere.
2. **`<meta name="taxi-server">`** — baked into the copied page at package time,
   because an app never launches with a query string:
   ```sh
   TAXI_SERVER=wss://host/socket/websocket npm run www
   ```
3. **The page's own origin** — right when client and server ship together, and
   only consulted for `http:`/`https:`. Inside the bundle the protocol is
   `capacitor:`, whose origin is the app itself and not a server, so it falls
   through to `ws://localhost:4000/socket/websocket` instead.

Without `TAXI_SERVER` the app therefore looks for a server on the build machine,
which is only useful in a simulator.
