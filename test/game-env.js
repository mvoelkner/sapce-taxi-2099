// Headless harness: runs the real game script against DOM stubs and exposes
// the IIFE internals so the new passenger/gear logic can be exercised.
const fs = require("fs");
const nodePath = require("path");
// Resolved from this file, not the working directory, so the harness runs from
// anywhere: `node test/harness.js` as well as from another folder entirely.
const ROOT = nodePath.resolve(__dirname, "..");
const html = fs.readFileSync(nodePath.join(ROOT, "index.html"), "utf8");
let js = html.split("<script>")[1].split("</script>")[0];

const EXPORTS = `
Object.defineProperties(globalThis, Object.getOwnPropertyDescriptors({
  LEVELS, initLevel, update, draw, crash, createTaxi, GEAR_LEN, PERSON_WALK, PERSON_HALF_W,
  input, nearLandingSurface, setThrustSound, setThrustHaptics, stopRumble,
  VIEW_W, VIEW_H, SECTOR_W, SECTOR_H,
  updateCamera, centerCameraOnTaxi, CAM_DEAD_W, CAM_DEAD_H,
  drawEdgeMarkers, edgeMarkerFor, C,
  showExplosion, hideExplosion, sndExplosion, primeExplosionSound,
  farePolicy, handleInput, bootGame, MENU_ENTRIES,
  netConnect, netDisconnect, netTick, netHeartbeat, netFrame, updateRemotes, netSend,
  haptic, HAPTICS, vibrate, registerServiceWorker,
  get $netState(){return netState}, get $netError(){return netError},
  get $myPlayerId(){return myPlayerId},
  get $roomState(){return roomState}, get $remotes(){return remotes},
  get $menuIndex(){return menuIndex}, set $menuIndex(v){menuIndex=v},
  get $gameMode(){return gameMode}, set $gameMode(v){gameMode=v},
  get $explosionPrimed(){return explosionPrimed}, set $explosionPrimed(v){explosionPrimed=v},
  get $viewScale(){return viewScale}, set $viewScale(v){viewScale=v},
  get $camera(){return camera},
  get $worldW(){return worldW}, get $worldH(){return worldH},
  get $starField(){return starField},
  sndHeyTaxi, touchdownFeedback, sndFuelWarn, ensureEngine, ensureAudio,
  loadHeyTaxiSample, playHeyTaxiSample, heyTaxiBeeps, unlockAudio,
  HEY_TAXI_MP3_B64,
  get $heyTaxiState(){return heyTaxiState}, set $heyTaxiState(v){heyTaxiState=v},
  get $heyTaxiBuffer(){return heyTaxiBuffer}, set $heyTaxiBuffer(v){heyTaxiBuffer=v},
  get $heyTaxiVoice(){return heyTaxiVoice},
  refuelViolation, loseLife, layoutCanvas, MAX_BACKING_PIXELS,
  rng, newRunSeed, tryTouchdown, PAD_SNAP, FUEL_SNAP, MAX_LAND_VY,
  get $runSeed(){return runSeed}, set $runSeed(v){runSeed=v},
  get $initCount(){return initCount}, set $initCount(v){initCount=v},
  get $engine(){return engine}, get $rumbling(){return rumbling},
  get $rumbleTick(){return rumbleTick},
  get $taxi(){return taxi}, set $taxi(v){taxi=v},
  get $passengers(){return passengers},
  get $messages(){return messages},
  get $particles(){return particles},
  get $pads(){return pads},
  get $state(){return state}, set $state(v){state=v},
  get $level(){return level}, set $level(v){level=v},
  get $lives(){return lives}, set $lives(v){lives=v},
  get $score(){return score},
  get $crashReason(){return crashReason},
  set $totalDelivered(v){totalPassengersDelivered=v},
}));
`;
const tail = js.lastIndexOf("})();");
js = js.slice(0, tail) + EXPORTS + js.slice(tail);

// ── DOM stubs ───────────────────────────────────────────────
const noop = () => {};
const ctxStub = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : noop),
  set: (t, k, v) => { t[k] = v; return true; },
});
const canvasStub = { width: 800, height: 500, style: {}, getContext: () => ctxStub };
const elStub = { classList: { toggle: noop }, hidden: false, addEventListener: noop, dataset: {} };

// The explosion overlay is a real DOM element, so it needs a classList that
// remembers and a style object that records what was written to it.
function classListStub() {
  const set = new Set();
  return {
    add: c => set.add(c),
    remove: c => set.delete(c),
    contains: c => set.has(c),
    toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
  };
}
const explosionStub = {
  classList: classListStub(), style: {}, offsetWidth: 130,
  addEventListener: noop, dataset: {},
};
// A thenable that settles at once, so prime/play paths run to completion here
const settled = { then: (ok) => { if (ok) ok(); return settled; }, catch: () => settled };
const explosionSoundStub = {
  muted: false, currentTime: 0, paused: true, plays: 0, pauses: 0,
  play() { this.plays++; this.paused = false; return settled; },
  pause() { this.pauses++; this.paused = true; },
  addEventListener: noop,
};

globalThis.document = {
  getElementById: id =>
    id === "game" ? canvasStub :
    id === "explosion" ? explosionStub :
    id === "explosion-sound" ? explosionSoundStub :
    { ...elStub },
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: noop,
  documentElement: { classList: { toggle: noop } },
  hidden: false,
};
globalThis.window = {
  addEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  devicePixelRatio: 1,
  innerWidth: 900,
  innerHeight: 700,
  requestAnimationFrame: noop,
};
// ── WebAudio + speech + vibration stubs that record what the game asks for ──
const audioLog = { params: [], sources: 0 };
const vibrationLog = [];
const speechLog = [];

function paramStub(name) {
  return {
    value: 0,
    setTargetAtTime: (v, t, c) => audioLog.params.push({ name, kind: "target", v }),
    setValueAtTime:  (v, t)    => audioLog.params.push({ name, kind: "value",  v }),
    exponentialRampToValueAtTime: (v, t) => audioLog.params.push({ name, kind: "ramp", v }),
  };
}
function nodeStub(kind) {
  const n = {
    kind,
    type: "", loop: false, buffer: null,
    frequency: paramStub(kind + ".frequency"),
    Q: paramStub(kind + ".Q"),
    gain: paramStub(kind + ".gain"),
    connect: t => t,
    start: () => { audioLog.sources++; },
    stop: noop,
  };
  return n;
}
globalThis.AudioContext = function () {
  return {
    state: "running",
    currentTime: 0,
    sampleRate: 44100,
    destination: nodeStub("destination"),
    createOscillator: () => nodeStub("osc"),
    createGain: () => nodeStub("gain"),
    createBiquadFilter: () => nodeStub("filter"),
    createBufferSource: () => nodeStub("bufsrc"),
    createBuffer: (ch, len) => ({ length: len, getChannelData: () => new Float32Array(len) }),
    decodeAudioData: (bytes, ok, err) => {
      audioLog.decodeBytes = bytes.byteLength;
      audioLog.decodeCalls = (audioLog.decodeCalls || 0) + 1;
      if (audioLog.failDecode) err(new Error("stub decode failure"));
      else ok({ duration: 0.81, __decoded: true });
    },
    resume: noop, suspend: noop,
  };
};
globalThis.window.AudioContext = globalThis.AudioContext;

// Node 21+ ships its own read-only `navigator` global, so a plain assignment
// is silently dropped. defineProperty is required to stub it.
Object.defineProperty(globalThis, "navigator", {
  value: { vibrate: p => { vibrationLog.push(p); return true; } },
  configurable: true,
  writable: true,
});
globalThis.SpeechSynthesisUtterance = function (text) { this.text = text; };
globalThis.window.speechSynthesis = {
  getVoices: () => [{ lang: "en-US", name: "Stub" }],
  addEventListener: noop,
  cancel: noop,
  speak: u => { speechLog.push(u); if (u.onstart) u.onstart(); },
};
// Timers are queued rather than dropped, so delayed sounds (sndSad, sndCrash,
// sndPickup) can be exercised on demand via flushTimers() without letting every
// unrelated watchdog fire in tests that don't want it.
const timerQueue = [];
globalThis.setTimeout = (fn, ms = 0) => timerQueue.push({ fn, ms });
function flushTimers() {
  const due = timerQueue.splice(0).sort((a, b) => a.ms - b.ms);
  for (const t of due) { try { t.fn(); } catch (e) {} }
  return due.length;
}

globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = noop;

// Served over http in tests, so the net layer derives a ws:// URL rather than
// taking its file:// fallback. forcedSeed reads the same search string and
// still finds no seed, so the seeded-run tests are unaffected.
globalThis.location = { protocol: "http:", host: "game.test", search: "" };

// ── WebSocket stub ──────────────────────────────────────────
// Records what the client sends and lets a test push server frames back in.
// No timers and no real socket: the handshake is driven explicitly, so a test
// can sit between any two steps of it.
const sockets = [];
class WebSocketStub {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;          // CONNECTING
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    sockets.push(this);
  }
  send(data) { this.sent.push(data); }
  close() {
    this.readyState = 3;          // CLOSED
    if (this.onclose) this.onclose({ code: 1000 });
  }
  // ── test-side helpers ──
  open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  deliver(frame) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) });
  }
  fail() { if (this.onerror) this.onerror({}); }
  frames() { return this.sent.map(JSON.parse); }
  lastOf(event) { return this.frames().filter(f => f[3] === event).pop(); }
}
WebSocketStub.CONNECTING = 0;
WebSocketStub.OPEN = 1;
WebSocketStub.CLOSING = 2;
WebSocketStub.CLOSED = 3;
globalThis.WebSocket = WebSocketStub;

// ── Capacitor stub ──────────────────────────────────────────
// Absent by default, so every existing test still exercises the web path.
// installCapacitor() puts a recording Haptics plugin in place of the real one.
const hapticLog = [];
function installCapacitor() {
  hapticLog.length = 0;
  globalThis.window.Capacitor = globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: {
      Haptics: {
        impact: o => hapticLog.push({ call: "impact", style: o && o.style }),
        notification: o => hapticLog.push({ call: "notification", type: o && o.type }),
        vibrate: o => hapticLog.push({ call: "vibrate", duration: o && o.duration }),
      },
    },
  };
}
function removeCapacitor() {
  delete globalThis.window.Capacitor;
  delete globalThis.Capacitor;
  hapticLog.length = 0;
}

new Function(js)();

// Shared by the test harness and the level extractor, so both drive the real
// game script through exactly one loading path.
module.exports = {
  ROOT, fs, nodePath,
  ctxStub, canvasStub, explosionStub, explosionSoundStub,
  audioLog, vibrationLog, speechLog, timerQueue, flushTimers, noop,
  sockets, WebSocketStub,
  hapticLog, installCapacitor, removeCapacitor,
};
