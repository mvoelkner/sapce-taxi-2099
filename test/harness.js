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

globalThis.document = {
  getElementById: id => (id === "game" ? canvasStub : { ...elStub }),
  querySelectorAll: () => [],
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

new Function(js)();

// ── Helpers ─────────────────────────────────────────────────
const fail = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); fail.push(name); }
}
function resetInput() { input.up = input.left = input.right = false; }
function step(n = 1) { for (let i = 0; i < n; i++) update(); }

// Taxi x that lands clear of whoever is actually standing on this pad.
// Only waiting/boarding fares have a real x - queued ones are still unplaced,
// so matching on padIndex alone would aim the taxi at coordinate 0.
function clearSpotOn(padIdx) {
  const pad = $pads[padIdx];
  const p = $passengers.find(x => x.padIndex === padIdx &&
                                  (x.phase === "waiting" || x.phase === "boarding"));
  if (!p) return pad.x + pad.w / 2 - $taxi.w / 2;
  const left  = (p.x - PERSON_HALF_W) - pad.x;
  const right = (pad.x + pad.w) - (p.x + PERSON_HALF_W);
  const x = left > right ? p.x - PERSON_HALF_W - 4 - $taxi.w
                         : p.x + PERSON_HALF_W + 4;
  return Math.max(pad.x, Math.min(x, pad.x + pad.w - $taxi.w));
}

// A synthetic multi-sector level, so camera behaviour can be exercised without
// changing any of the five shipped levels. Always pop it again afterwards.
function pushTestLevel(cols, rows) {
  LEVELS.push({
    name: "TEST GRID",
    gravity: 0.04,
    cols, rows,
    pads: [
      { x: 60,                  y: 430,             w: 130, label: "1", color: "#55ff55" },
      { x: cols * 800 - 200,    y: rows * 500 - 70, w: 130, label: "2", color: "#70a4b2" },
    ],
    fares: 1,
    obstacles: [],
    fuelStations: [],
  });
  return LEVELS.length - 1;
}

// Park the taxi cleanly on a pad, gear down, no vertical speed.
function parkOn(padIdx, x) {
  const pad = $pads[padIdx];
  const t = $taxi;
  t.x = x === undefined ? pad.x + pad.w / 2 - t.w / 2 : x;
  t.y = pad.y - t.h - GEAR_LEN;
  t.vx = 0; t.vy = 0;
  t.gear = 1;
  t.landed = true;
  t.landedPad = padIdx;
}

console.log("\n=== 1. Random routes: independent pairs ===");
$level = 0; $lives = 99; $totalDelivered = 0;
const seen = new Set();
let selfDeliver = 0, chained = 0, runs = 400;
for (let r = 0; r < runs; r++) {
  initLevel();
  $passengers.forEach(p => {
    seen.add(`${p.padIndex}>${p.destPadIndex}`);
    if (p.padIndex === p.destPadIndex) selfDeliver++;
  });
  for (let i = 1; i < $passengers.length; i++) {
    if ($passengers[i].padIndex === $passengers[i - 1].destPadIndex) chained++;
  }
}
check("never routes a fare to its own pickup pad", selfDeliver === 0, `(${selfDeliver} hits)`);
check("uses all 6 possible pad pairs on a 3-pad level", seen.size === 6, `(saw ${seen.size})`);
check("pairs are independent, not chained", chained > 0 && chained < runs, `(${chained}/${runs} legs happened to chain)`);

console.log("\n=== 1b. Seeded routes are reproducible ===");
function routeFor(seed, levels) {
  $runSeed = seed; $initCount = 0;
  const out = [];
  for (const l of levels) {
    $level = l; $lives = 99; $state = "playing"; initLevel();
    out.push($passengers.map(p => `${p.padIndex}>${p.destPadIndex}`).join(" ") +
             " @" + $passengers[0].x.toFixed(3));
  }
  return out.join(" | ");
}
const runA = routeFor(123456, [0, 1, 2, 3, 4]);
const runB = routeFor(123456, [0, 1, 2, 3, 4]);
const runC = routeFor(999999, [0, 1, 2, 3, 4]);
check("same seed replays the identical run", runA === runB, `\n     A: ${runA}\n     B: ${runB}`);
check("a different seed gives a different run", runA !== runC, `(both "${runA}")`);
check("stand positions are seeded too, not just the pairs",
      runA.includes("@") && runA !== runC);

// A retry must still re-roll, or you could never get a different attempt
$runSeed = 555; $initCount = 0;
$level = 0; $lives = 99; $state = "playing";
initLevel();
const firstTry = $passengers.map(p => `${p.padIndex}>${p.destPadIndex}`).join(" ");
let differs = false;
for (let i = 0; i < 8 && !differs; i++) {
  initLevel();
  if ($passengers.map(p => `${p.padIndex}>${p.destPadIndex}`).join(" ") !== firstTry) differs = true;
}
check("retrying the same level re-rolls the route", differs, `(stuck on "${firstTry}")`);

// The generator itself must be well behaved
$runSeed = 42; $initCount = 0; initLevel();
let lo = 1, hi = 0, sum = 0;
const N = 200000;
for (let i = 0; i < N; i++) { const v = rng(); lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; }
check("rng() stays inside [0,1)", lo >= 0 && hi < 1, `(min=${lo.toFixed(6)}, max=${hi.toFixed(6)})`);
check("rng() is roughly uniform", Math.abs(sum / N - 0.5) < 0.005, `(mean=${(sum / N).toFixed(5)})`);

console.log("\n=== 1c. Viewport and world are separate concepts ===");
check("viewport stays a fixed 800x500", VIEW_W === 800 && VIEW_H === 500,
      `(${VIEW_W}x${VIEW_H})`);
check("a sector is one viewport", SECTOR_W === VIEW_W && SECTOR_H === VIEW_H);
for (let li = 0; li < LEVELS.length; li++) {
  $level = li; $lives = 99; $state = "playing"; initLevel();
  check(`L${li + 1} is a single sector`,
        LEVELS[li].cols === 1 && LEVELS[li].rows === 1,
        `(${LEVELS[li].cols}x${LEVELS[li].rows})`);
  check(`L${li + 1} world equals one viewport`,
        $worldW === VIEW_W && $worldH === VIEW_H,
        `(${$worldW}x${$worldH})`);
}
// A multi-sector level must widen the world, not the viewport
const testIdx = pushTestLevel(3, 2);
$level = testIdx; $lives = 99; $state = "playing"; initLevel();
check("a 3x2 level yields a 2400x1000 world", $worldW === 2400 && $worldH === 1000,
      `(${$worldW}x${$worldH})`);
check("the viewport is unaffected by world size", VIEW_W === 800 && VIEW_H === 500);
check("stars are spread across the whole world",
      $starField.some(s => s.x > VIEW_W) && $starField.some(s => s.y > VIEW_H),
      `(${$starField.length} stars, max x=${Math.max(...$starField.map(s => s.x)).toFixed(0)})`);
check("star count scales with world area",
      $starField.length === 80 * 6, `(${$starField.length}, expected 480)`);
// The taxi must be free to fly into the extra sectors
$taxi.x = 2000; $taxi.y = 800; $taxi.vx = 0; $taxi.vy = 0; $taxi.landed = false;
update();
check("the taxi is not clamped at the old 800px edge", $taxi.x > 800, `(x=${$taxi.x})`);
check("the taxi is still clamped at the world edge",
      (() => { $taxi.x = 5000; update(); return $taxi.x <= $worldW - $taxi.w + 0.001; })(),
      `(x=${$taxi.x}, worldW=${$worldW})`);
LEVELS.pop();
$level = 0; $lives = 99; $state = "playing"; initLevel();

console.log("\n=== 2. Passenger stands within reach on the pad ===");
let offPad = 0, tooTight = 0;
for (let r = 0; r < 300; r++) {
  initLevel();
  for (const p of $passengers.filter(p => p.phase === "waiting")) {
    const pad = $pads[p.padIndex];
    if (p.x - PERSON_HALF_W < pad.x || p.x + PERSON_HALF_W > pad.x + pad.w) offPad++;
    // is there room for a 32px taxi entirely clear of the passenger?
    const leftRoom  = (p.x - PERSON_HALF_W) - pad.x;
    const rightRoom = (pad.x + pad.w) - (p.x + PERSON_HALF_W);
    if (Math.max(leftRoom, rightRoom) < 34) tooTight++;
  }
}
check("passenger always stands on the pad deck", offPad === 0, `(${offPad} off-pad)`);
check("always leaves room to land clear of them", tooTight === 0, `(${tooTight} impossible spots)`);

console.log("\n=== 3. Landing on the passenger is fatal ===");
$level = 0; $lives = 99; initLevel();
let p0 = $passengers[0];
parkOn(p0.padIndex, p0.x - $taxi.w / 2);   // dead centre on top of them
const livesBefore = $lives;
step(1);
check("crash triggered", $state === "crashed", `(state=${$state})`);
check("reports PASSENGER CRUSHED!", $crashReason === "PASSENGER CRUSHED!", `(got "${$crashReason}")`);
check("costs a life", $lives === livesBefore - 1);

console.log("\n=== 4. Landing beside them boards the fare ===");
$level = 0; $lives = 99; $state = "playing"; initLevel();
p0 = $passengers[0];
parkOn(p0.padIndex, clearSpotOn(p0.padIndex));
step(1);
check("no crush when clear", $state === "playing", `(state=${$state}, reason=${$crashReason})`);
check("passenger starts walking", p0.phase === "boarding", `(phase=${p0.phase})`);
const startX = p0.x;
step(200);
check("walked towards the taxi door", Math.abs(p0.x - startX) > 1);
check("boarded within ~3s", p0.phase === "aboard", `(phase=${p0.phase})`);
check("taxi carries the fare", $taxi.hasPassenger === true);
check("destination is not the pickup pad", $taxi.passengerDest !== p0.padIndex);

console.log("\n=== 5. Taking off mid-boarding aborts it ===");
$level = 0; $lives = 99; $state = "playing"; initLevel();
let p1 = $passengers[0];
parkOn(p1.padIndex, clearSpotOn(p1.padIndex));
step(1);
check("boarding started", p1.phase === "boarding");
$taxi.landed = false; $taxi.landedPad = -1; $taxi.y -= 40;
step(1);
check("reverts to waiting", p1.phase === "waiting", `(phase=${p1.phase})`);
check("no fare stolen", $taxi.hasPassenger === false);

console.log("\n=== 6. Landing gear ===");
$level = 0; $lives = 99; $state = "playing"; initLevel();
let t = $taxi;
// x=400 would sit right above level 1's fuel station, so use genuinely open sky
t.x = 200; t.y = 100; t.gear = 0;
check("chosen spot really is open sky", nearLandingSurface() === false);
step(1);
check("stays retracted in open space", t.gear === 0, `(gear=${t.gear})`);
t.gear = 1;
step(60);
check("retracts again away from pads", t.gear < 1, `(gear=${t.gear})`);

// approach pad 0 from above
$state = "playing"; initLevel(); t = $taxi;
const padG = $pads[0];
t.x = padG.x + 50; t.y = padG.y - 60; t.vx = 0; t.vy = 0; t.gear = 0;
step(1);
check("deploys near a pad", t.gear > 0, `(gear=${t.gear})`);
step(30);
check("fully out within ~0.5s", t.gear >= 1, `(gear=${t.gear})`);

console.log("\n=== 7. Dive-bombing a pad: gear never makes it out ===");
$state = "playing"; $lives = 99; initLevel(); t = $taxi;
const padH = $pads[0];
// Land clear of the passenger so this isolates the gear rule
// Start just above the gear zone and drop fast — a real dive, not a posed frame
t.x = clearSpotOn(0); t.y = padH.y - t.h - 95; t.vx = 0; t.vy = 6; t.gear = 0;
for (let i = 0; i < 60 && $state === "playing"; i++) update();
check("crashes", $state === "crashed", `(state=${$state})`);
check("reports GEAR NOT DOWN!", $crashReason === "GEAR NOT DOWN!", `(got "${$crashReason}")`);

console.log("\n=== 8. A gentle, gear-down approach still lands ===");
$state = "playing"; $lives = 99; initLevel(); t = $taxi;
const padI = $pads[0];
// start 70px up over a spot clear of the fare, drift down with light thrust
t.x = clearSpotOn(0); t.y = padI.y - t.h - 70; t.vx = 0; t.vy = 0; t.gear = 0;
let landed = false;
for (let i = 0; i < 400 && $state === "playing"; i++) {
  input.up = $taxi.vy > 0.9;          // crude autopilot: brake when falling fast
  update();
  if ($taxi.landed) { landed = true; break; }
}
resetInput();
check("lands without crashing", landed && $state === "playing", `(state=${$state}, reason=${$crashReason})`);
check("gear was down at touchdown", $taxi.gear >= 1);
check("rests on its feet, not its hull", Math.abs(($taxi.y + $taxi.h + GEAR_LEN) - padI.y) < 0.001,
      `(feet=${$taxi.y + $taxi.h + GEAR_LEN}, pad=${padI.y})`);

console.log("\n=== 8b. Regression: next fare must never spawn under a parked taxi ===");
// Route A>B followed by B>C leaves the taxi sitting on B when the next fare
// activates there. Force that shape and check it can never be an instant death.
let spawnedUnder = 0, crushedOnArrival = 0;
for (let r = 0; r < 500; r++) {
  $level = r % LEVELS.length; $lives = 99; $state = "playing";
  initLevel();
  const a = $passengers[0], b = $passengers[1];
  if (!b) continue;
  b.padIndex = a.destPadIndex;                       // force the collision case
  if (b.destPadIndex === b.padIndex) b.destPadIndex = (b.padIndex + 1) % $pads.length;
  a.phase = "delivered";                             // pretend fare A is done
  $taxi.hasPassenger = false;
  parkOn(b.padIndex);                                // taxi parked mid-pad
  step(1);                                           // activates fare B
  const lo = $taxi.x - PERSON_HALF_W, hi = $taxi.x + $taxi.w + PERSON_HALF_W;
  if (b.x > lo && b.x < hi) spawnedUnder++;
  if ($state === "crashed" && $crashReason === "PASSENGER CRUSHED!") crushedOnArrival++;
}
check("never spawns inside the taxi footprint", spawnedUnder === 0, `(${spawnedUnder}/500)`);
check("never an instant crush on arrival", crushedOnArrival === 0, `(${crushedOnArrival}/500)`);

console.log("\n=== 9. Every level completes, across many random routes ===");
function playThrough() {
  $lives = 99; $state = "playing"; $totalDelivered = 0;
  initLevel();
  let guard = 0;
  while ($state === "playing" && guard++ < 200) {
    const p = $passengers.find(x => x.phase !== "delivered");
    if (!p) break;
    if (p.phase === "queued") { step(1); continue; }
    if (p.phase === "aboard") { parkOn(p.destPadIndex); step(1); continue; }
    parkOn(p.padIndex, clearSpotOn(p.padIndex));
    step(300);
  }
  return $state === "levelComplete" && $passengers.every(x => x.phase === "delivered");
}
for (let li = 0; li < LEVELS.length; li++) {
  $level = li;
  let wins = 0;
  const RUNS = 200;
  for (let r = 0; r < RUNS; r++) if (playThrough()) wins++;
  check(`L${li + 1} ${LEVELS[li].name}: solvable on all ${RUNS} random routes`,
        wins === RUNS, `(${wins}/${RUNS})`);
}

console.log("\n=== 8c. Refuelling with a fare aboard ===");
// Park on a fuel station with a passenger and a part-empty tank
function parkOnFuelStation(withFare, fuel) {
  $level = 0; $lives = 99; $state = "playing"; initLevel();
  const fs = LEVELS[0].fuelStations[0];
  const t = $taxi;
  t.x = fs.x + fs.w / 2 - t.w / 2;
  t.y = fs.y - t.h - GEAR_LEN;
  t.vx = 0; t.vy = 0; t.gear = 1;
  t.fuel = fuel;
  t.hasPassenger = withFare;
  t.passengerDest = withFare ? 1 : -1;
  return fs;
}

parkOnFuelStation(true, 40);
const livesBeforeRefuel = $lives;
const fuelBefore = $taxi.fuel;
step(1);
check("costs a life", $lives === livesBeforeRefuel - 1, `(${livesBeforeRefuel} -> ${$lives})`);
check("reports the reason", $crashReason === "NO REFUELLING WITH A FARE!", `(got "${$crashReason}")`);
check("ends the run like a crash", $state === "crashed", `(state=${$state})`);
check("no fuel was actually taken", $taxi.fuel === fuelBefore, `(${fuelBefore} -> ${$taxi.fuel})`);

// It must not fire again while the state is settled
const livesAfter = $lives;
step(5);
check("does not drain further lives per step", $lives === livesAfter, `(${livesAfter} -> ${$lives})`);

// Same station, no fare: refuelling must still work
parkOnFuelStation(false, 40);
const beforeOk = $taxi.fuel;
step(1);
check("refuelling without a fare still works", $taxi.fuel > beforeOk && $state === "playing",
      `(${beforeOk} -> ${$taxi.fuel}, state=${$state})`);

// Full tank with a fare: nothing is drawn, so no penalty
parkOnFuelStation(true, 100);
const livesFull = $lives;
step(1);
check("full tank with a fare is not punished", $lives === livesFull && $state === "playing",
      `(lives=${$lives}, state=${$state})`);

// Sound + haptics distinct from a crash, and no wreck
$level = 0; $lives = 99; $state = "playing"; initLevel();   // clears particles
audioLog.sources = 0; vibrationLog.length = 0;
timerQueue.length = 0;
refuelViolation();
const sadNotes = flushTimers();
check("plays a sound", audioLog.sources > 0, `(${audioLog.sources} sources)`);
check("sad tone is a multi-note phrase", sadNotes >= 4, `(${sadNotes} scheduled notes)`);
const droop = audioLog.params.filter(p => p.name === "osc.frequency" && p.kind === "ramp");
check("last note bends downward", droop.some(p => p.v < 262), `(${JSON.stringify(droop.map(p=>p.v))})`);
check("vibrates with its own pattern", vibrationLog.length === 1 && vibrationLog[0][0] === 180,
      `(${JSON.stringify(vibrationLog)})`);
check("no explosion particles spawned", $particles.length === 0, `(${$particles.length})`);

// A real crash by contrast still explodes
$state = "playing"; $lives = 99; initLevel();
crash("TEST");
check("crash by contrast does spawn particles", $particles.length > 0, `(${$particles.length})`);

// Last life -> game over rather than retry
$state = "playing"; $lives = 1;
refuelViolation();
check("last life ends the game", $state === "gameOver", `(state=${$state})`);

console.log("\n=== 9b. Rocket engine sound ===");
ensureAudio(); ensureEngine();
check("engine graph is built", !!$engine);
audioLog.params.length = 0;
setThrustSound(true, false);
let lowUp = audioLog.params.filter(p => p.name === "gain.gain" && p.v > 0);
check("main thrust opens the noise gains", lowUp.length >= 2, `(${lowUp.length} gain moves)`);
const cutMain = audioLog.params.filter(p => p.name === "filter.frequency").pop();
audioLog.params.length = 0;
setThrustSound(true, false);
check("idempotent: unchanged state does not re-automate", audioLog.params.length === 0,
      `(${audioLog.params.length} redundant moves)`);
audioLog.params.length = 0;
setThrustSound(false, true);
const cutSide = audioLog.params.filter(p => p.name === "filter.frequency").pop();
check("side jets use a brighter cutoff than main", cutSide && cutMain && cutSide.v > cutMain.v,
      `(side=${cutSide && cutSide.v} main=${cutMain && cutMain.v})`);
audioLog.params.length = 0;
setThrustSound(false, false);
const silenced = audioLog.params.filter(p => p.name === "gain.gain" && p.v === 0);
check("releasing thrust closes both gains", silenced.length >= 2, `(${silenced.length} zeroed)`);

console.log("\n=== 9c. HEY TAXI sample ===");
// The embedded base64 must survive a round trip back to the original file
const mp3OnDisk = fs.readFileSync(nodePath.join(ROOT, "hey-taxi.mp3"));
check("embedded base64 is valid and decodes",
      /^[A-Za-z0-9+/]+={0,2}$/.test(HEY_TAXI_MP3_B64), "(unerwartete Zeichen)");
check("embedded sample matches hey-taxi.mp3 byte for byte",
      Buffer.from(HEY_TAXI_MP3_B64, "base64").equals(mp3OnDisk),
      `(${Buffer.from(HEY_TAXI_MP3_B64, "base64").length} vs ${mp3OnDisk.length} bytes)`);
check("no speechSynthesis dependency left", typeof speakHeyTaxi === "undefined");

// Fresh decode
$heyTaxiState = "idle"; $heyTaxiBuffer = null;
audioLog.decodeCalls = 0; audioLog.failDecode = false;
ensureAudio();
loadHeyTaxiSample();
check("decodes once on load", audioLog.decodeCalls === 1, `(${audioLog.decodeCalls})`);
check("decoded the whole file", audioLog.decodeBytes === mp3OnDisk.length,
      `(${audioLog.decodeBytes} vs ${mp3OnDisk.length})`);
check("reaches ready state", $heyTaxiState === "ready", `(${$heyTaxiState})`);
loadHeyTaxiSample(); loadHeyTaxiSample();
check("does not decode again on repeat calls", audioLog.decodeCalls === 1, `(${audioLog.decodeCalls})`);

// Playback
audioLog.sources = 0; vibrationLog.length = 0;
sndHeyTaxi();
check("plays the sample", audioLog.sources === 1, `(${audioLog.sources} sources)`);
check("vibrates alongside the shout", vibrationLog.length === 1, `(${vibrationLog.length})`);
check("keeps a handle on the playing voice", $heyTaxiVoice !== null);
const firstVoice = $heyTaxiVoice;
sndHeyTaxi();
check("a second shout replaces the first rather than stacking",
      $heyTaxiVoice !== null && $heyTaxiVoice !== firstVoice);

// Still decoding -> must not fall silent
$heyTaxiState = "loading"; $heyTaxiBuffer = null;
audioLog.sources = 0; vibrationLog.length = 0;
sndHeyTaxi();
check("beeps while the sample is still decoding", audioLog.sources > 0, `(${audioLog.sources})`);
check("still vibrates while decoding", vibrationLog.length === 1);

// Decode failure -> must not fall silent either
$heyTaxiState = "idle"; $heyTaxiBuffer = null;
audioLog.failDecode = true; audioLog.sources = 0; vibrationLog.length = 0;
sndHeyTaxi();
check("marks the sample as failed", $heyTaxiState === "failed", `(${$heyTaxiState})`);
check("beeps when decoding fails", audioLog.sources > 0, `(${audioLog.sources})`);
audioLog.failDecode = false;

// unlockAudio primes the sample so the very first shout is never a beep
$heyTaxiState = "idle"; $heyTaxiBuffer = null; audioLog.decodeCalls = 0;
unlockAudio();
check("unlockAudio primes the sample in a gesture",
      $heyTaxiState === "ready" && audioLog.decodeCalls === 1,
      `(state=${$heyTaxiState}, decodes=${audioLog.decodeCalls})`);

console.log("\n=== 9d. Vibration events ===");
vibrationLog.length = 0;
touchdownFeedback(0.3);
const soft = vibrationLog.pop();
touchdownFeedback(1.5);
const hard = vibrationLog.pop();
check("hard landing buzzes longer than soft", hard[0] > soft[0], `(soft=${soft} hard=${hard})`);
vibrationLog.length = 0;
sndFuelWarn();
check("fuel warning vibrates", vibrationLog.length === 1, `(${vibrationLog.length})`);

console.log("\n=== 9e. Thrust rumble re-triggering ===");
stopRumble(); vibrationLog.length = 0;
for (let i = 0; i < 36; i++) setThrustHaptics(true);
check("re-issues roughly every 12 steps over 36 steps", vibrationLog.length === 3,
      `(${vibrationLog.length} buzzes)`);
check("buzz outlasts its interval so it overlaps", vibrationLog[0] === 220, `(${vibrationLog[0]}ms)`);
vibrationLog.length = 0;
setThrustHaptics(false);
check("releasing thrust cancels the rumble", vibrationLog.length === 1 && vibrationLog[0] === 0,
      `(${JSON.stringify(vibrationLog)})`);
vibrationLog.length = 0;
setThrustHaptics(false);
check("no repeated cancels when already idle", vibrationLog.length === 0, `(${vibrationLog.length})`);

console.log("\n=== 9f. Crash buzz survives the rumble cancel ===");
$level = 0; $lives = 99; $state = "playing"; initLevel();
stopRumble();
for (let i = 0; i < 3; i++) setThrustHaptics(true);   // rumbling now active
vibrationLog.length = 0;
crash("TEST");
check("crash issues its own pattern", vibrationLog.length === 1 && Array.isArray(vibrationLog[0]),
      `(${JSON.stringify(vibrationLog)})`);
check("rumble flag cleared so no vibrate(0) follows", $rumbling === false);
setThrustHaptics(false);   // what gameLoop does right after
check("no cancel overwrites the crash buzz", vibrationLog.length === 1,
      `(${JSON.stringify(vibrationLog)})`);

console.log("\n=== 9h. Thruster exhaust leaves the correct side ===");
// Newton: to accelerate left the taxi must throw mass to the right. The plume
// therefore has to start on the side opposite the travel direction AND move
// away from the hull - if position and velocity disagree it flies through the taxi.
function plumeFor(dir) {
  $level = 0; $lives = 99; $state = "playing"; initLevel();
  const t = $taxi;
  t.x = 400; t.y = 200; t.vx = 0; t.vy = 0; t.landed = false; t.fuel = 100;
  t.gear = 0;
  input.up = false; input.left = dir === "left"; input.right = dir === "right";
  $particles.length = 0;
  update();
  resetInput();
  const mid = t.x + t.w / 2;
  return $particles.map(p => ({ side: p.x < mid ? "left" : "right", vx: p.vx }));
}

const leftPlume = plumeFor("left");
check("left thrust produces exhaust", leftPlume.length > 0, `(${leftPlume.length})`);
check("left thrust: plume exits the RIGHT side",
      leftPlume.every(p => p.side === "right"),
      `(${leftPlume.map(p => p.side).join(",")})`);
check("left thrust: plume travels rightward, away from the hull",
      leftPlume.every(p => p.vx > 0),
      `(${leftPlume.map(p => p.vx.toFixed(2)).join(",")})`);

const rightPlume = plumeFor("right");
check("right thrust produces exhaust", rightPlume.length > 0, `(${rightPlume.length})`);
check("right thrust: plume exits the LEFT side",
      rightPlume.every(p => p.side === "left"),
      `(${rightPlume.map(p => p.side).join(",")})`);
check("right thrust: plume travels leftward, away from the hull",
      rightPlume.every(p => p.vx < 0),
      `(${rightPlume.map(p => p.vx.toFixed(2)).join(",")})`);

// Up thrust was never reported as wrong - guard it stays that way
$level = 0; $lives = 99; $state = "playing"; initLevel();
$taxi.x = 400; $taxi.y = 200; $taxi.landed = false; $taxi.fuel = 100;
input.up = true; input.left = input.right = false;
$particles.length = 0;
update();
resetInput();
const upPlume = $particles;
check("up thrust: plume exits below the hull",
      upPlume.length > 0 && upPlume.every(p => p.y >= $taxi.y + $taxi.h - 1),
      `(${upPlume.length} particles)`);
check("up thrust: plume travels downward",
      upPlume.every(p => p.vy > 0), `(${upPlume.map(p => p.vy.toFixed(2)).join(",")})`);

console.log("\n=== 9g. Desktop canvas fills the window ===");
function layoutAt(w, h, dpr) {
  window.innerWidth = w; window.innerHeight = h; window.devicePixelRatio = dpr;
  layoutCanvas();
  return {
    cssW: parseFloat(canvasStub.style.width),
    cssH: parseFloat(canvasStub.style.height),
    bufW: canvasStub.width,
    bufH: canvasStub.height,
  };
}
const big = layoutAt(2560, 1440, 1);
check("scales past the old 800x500 cap", big.cssW > 800, `(${big.cssW}x${big.cssH})`);
check("uses the height on a 16:9 screen", big.cssH <= 1440 && big.cssH > 1200, `(h=${big.cssH})`);
check("keeps the 8:5 aspect ratio", Math.abs(big.cssW / big.cssH - VIEW_W / VIEW_H) < 0.01,
      `(${(big.cssW / big.cssH).toFixed(3)} vs ${(VIEW_W / VIEW_H).toFixed(3)})`);

const ultrawide = layoutAt(3440, 1000, 1);
check("a short wide window is limited by height", ultrawide.cssH <= 1000 && ultrawide.cssW <= 3440,
      `(${ultrawide.cssW}x${ultrawide.cssH})`);
check("still 8:5 when width is abundant", Math.abs(ultrawide.cssW / ultrawide.cssH - VIEW_W / VIEW_H) < 0.01);

const tall = layoutAt(900, 2000, 1);
check("a narrow tall window is limited by width", tall.cssW <= 900, `(${tall.cssW}x${tall.cssH})`);

const small = layoutAt(640, 480, 1);
check("shrinks below native on a small window", small.cssW < 800 && small.cssW > 0,
      `(${small.cssW}x${small.cssH})`);
check("never overflows the viewport", small.cssW <= 640 && small.cssH <= 480,
      `(${small.cssW}x${small.cssH})`);

const retina = layoutAt(2560, 1440, 3);
check("clamps the backing store to the pixel budget",
      retina.bufW * retina.bufH <= MAX_BACKING_PIXELS * 1.01,
      `(${retina.bufW}x${retina.bufH} = ${(retina.bufW * retina.bufH / 1e6).toFixed(1)}MP, budget ${(MAX_BACKING_PIXELS / 1e6).toFixed(1)}MP)`);
check("backing store still matches the css aspect ratio",
      Math.abs(retina.bufW / retina.bufH - VIEW_W / VIEW_H) < 0.02,
      `(${(retina.bufW / retina.bufH).toFixed(3)})`);

const modest = layoutAt(1280, 800, 2);
check("normal retina laptop keeps full DPR", modest.bufW === Math.round(modest.cssW * 2),
      `(buf=${modest.bufW}, css=${modest.cssW})`);

layoutAt(900, 700, 1);   // restore for the remaining tests

console.log("\n=== 9i. Camera ===");
// One sector: the camera can never move, which is what keeps single player
// looking exactly as it did before.
$level = 0; $lives = 99; $state = "playing"; initLevel();
centerCameraOnTaxi();
check("stays at the origin in a one-sector world",
      $camera.x === 0 && $camera.y === 0, `(${$camera.x},${$camera.y})`);
$taxi.x = 700; $taxi.y = 400;
updateCamera();
check("still cannot move in a one-sector world",
      $camera.x === 0 && $camera.y === 0, `(${$camera.x},${$camera.y})`);

// Multi-sector world
const camIdx = pushTestLevel(3, 2);
$level = camIdx; $lives = 99; $state = "playing"; initLevel();
$taxi.x = 1200; $taxi.y = 500; $taxi.landed = false;
centerCameraOnTaxi();
const centred = { x: $camera.x, y: $camera.y };
check("centres on the taxi when the world allows it",
      Math.abs(centred.x - (1200 + $taxi.w/2 - VIEW_W/2)) < 0.001,
      `(cam.x=${centred.x})`);

// Dead zone: small movements must not shift the view at all
$taxi.x = 1200 + CAM_DEAD_W/2 - 20;
updateCamera();
check("a small move inside the dead zone does not shift the camera",
      $camera.x === centred.x, `(${$camera.x} vs ${centred.x})`);

// Leaving the dead zone drags the camera along
$taxi.x = 1200 + CAM_DEAD_W;
updateCamera();
check("leaving the dead zone drags the camera", $camera.x > centred.x,
      `(${$camera.x} vs ${centred.x})`);
check("drags no further than necessary",
      Math.abs(($taxi.x + $taxi.w/2) - ($camera.x + (VIEW_W + CAM_DEAD_W)/2)) < 0.001,
      `(taxi centre ${$taxi.x + $taxi.w/2}, dead-zone edge ${$camera.x + (VIEW_W + CAM_DEAD_W)/2})`);

// Clamping at all four world edges
$taxi.x = 0; $taxi.y = 0; updateCamera();
check("clamps at the top-left corner", $camera.x === 0 && $camera.y === 0,
      `(${$camera.x},${$camera.y})`);
$taxi.x = $worldW; $taxi.y = $worldH; updateCamera();
check("clamps at the bottom-right corner",
      $camera.x === $worldW - VIEW_W && $camera.y === $worldH - VIEW_H,
      `(${$camera.x},${$camera.y} vs ${$worldW - VIEW_W},${$worldH - VIEW_H})`);

// The camera must never influence the simulation
$taxi.x = 1200; $taxi.y = 500; $taxi.vx = 0.3; $taxi.vy = 0.2; $taxi.landed = false;
$camera.x = 0; $camera.y = 0;
update();
const withCamAtOrigin = { x: $taxi.x, y: $taxi.y, vx: $taxi.vx, vy: $taxi.vy };
$taxi.x = 1200; $taxi.y = 500; $taxi.vx = 0.3; $taxi.vy = 0.2; $taxi.landed = false;
$camera.x = 900; $camera.y = 300;
update();
check("the simulation is unaffected by camera position",
      $taxi.x === withCamAtOrigin.x && $taxi.y === withCamAtOrigin.y &&
      $taxi.vx === withCamAtOrigin.vx && $taxi.vy === withCamAtOrigin.vy,
      `(${$taxi.x},${$taxi.y} vs ${withCamAtOrigin.x},${withCamAtOrigin.y})`);
LEVELS.pop();
$level = 0; $lives = 99; $state = "playing"; initLevel();

console.log("\n=== 9j. HUD is screen space, world is not ===");
// Record what the renderer emits, tracking the active transform
const drawOps = [];
ctxStub.save = () => drawOps.push({ op: "save" });
ctxStub.restore = () => drawOps.push({ op: "restore" });
ctxStub.translate = (x, y) => drawOps.push({ op: "translate", x, y });
ctxStub.fillText = (t, x, y) => drawOps.push({ op: "text", t, x, y });

const drawIdx = pushTestLevel(3, 2);
$level = drawIdx; $lives = 99; $state = "playing"; initLevel();
$taxi.x = 1200; $taxi.y = 500; $taxi.landed = false;
centerCameraOnTaxi();
drawOps.length = 0;
draw();

const translates = drawOps.filter(o => o.op === "translate");
check("the world is drawn under a camera translation",
      translates.some(t => t.x === -$camera.x && t.y === -$camera.y),
      `(${JSON.stringify(translates)})`);
check("the translation is balanced by save/restore",
      drawOps.filter(o => o.op === "save").length ===
      drawOps.filter(o => o.op === "restore").length,
      `(${drawOps.filter(o => o.op === "save").length} save / ${drawOps.filter(o => o.op === "restore").length} restore)`);

// The HUD must be emitted after the restore, i.e. in screen space
const lastRestore = drawOps.map(o => o.op).lastIndexOf("restore");
const scoreOp = drawOps.findIndex(o => o.op === "text" && String(o.t).startsWith("SCORE"));
check("the HUD is drawn after the camera transform is popped",
      scoreOp > lastRestore, `(score at ${scoreOp}, last restore at ${lastRestore})`);

// And its coordinates must not move when the camera does
const scoreAt = camX => {
  $camera.x = camX; drawOps.length = 0; draw();
  return drawOps.find(o => o.op === "text" && String(o.t).startsWith("SCORE"));
};
const hudA = scoreAt(0);
const hudB = scoreAt(900);
check("HUD coordinates are independent of the camera",
      hudA && hudB && hudA.x === hudB.x && hudA.y === hudB.y,
      `(${hudA && hudA.x} vs ${hudB && hudB.x})`);

// Off-screen stars must be skipped
$camera.x = 0; $camera.y = 0;
let starDraws = 0;
ctxStub.fillRect = () => starDraws++;
drawOps.length = 0;
draw();
check("stars outside the view are culled",
      starDraws < $starField.length, `(${starDraws} rects vs ${$starField.length} stars)`);

LEVELS.pop();
$level = 0; $lives = 99; $state = "playing"; initLevel();

console.log("\n=== 9k. Edge markers for off-screen targets ===");
const edgeIdx = pushTestLevel(3, 2);
$level = edgeIdx; $lives = 99; $state = "playing"; initLevel();
$camera.x = 0; $camera.y = 0;

check("a point inside the view gets no marker",
      edgeMarkerFor(400, 250) === null, "(marker returned for a visible point)");

const right = edgeMarkerFor(2000, 250);
check("a point to the right yields a marker", right !== null);
check("the marker sits on the right edge", right && right.x > VIEW_W - 40,
      `(x=${right && right.x})`);
check("the marker stays inside the viewport",
      right && right.x <= VIEW_W && right.y >= 0 && right.y <= VIEW_H,
      `(${right && right.x},${right && right.y})`);

const below = edgeMarkerFor(400, 900);
check("a point below yields a marker on the bottom edge",
      below && below.y > VIEW_H - 40, `(y=${below && below.y})`);

const corner = edgeMarkerFor(2400, 1000);
check("a diagonal target is clamped to a corner",
      corner && corner.x > VIEW_W - 40 && corner.y > VIEW_H - 40,
      `(${corner && corner.x},${corner && corner.y})`);

// Two distinguishable colours: pickup while empty, destination while carrying.
// The markers blink, so the timer has to sit in a visible phase.
for (let i = 0; i < 10; i++) update();
$camera.x = 0; $camera.y = 0;

const colours = [];
Object.defineProperty(ctxStub, "fillStyle", {
  set(v) { colours.push(v); }, get() { return ""; }, configurable: true,
});
$taxi.hasPassenger = false;
$passengers[0].phase = "waiting";
$passengers[0].padIndex = 1;              // pad 2 lies in a far sector
colours.length = 0;
drawEdgeMarkers();
check("an off-screen pickup pad is marked in the pickup colour",
      colours.includes(C.padGreen), `(${JSON.stringify(colours)})`);

$taxi.hasPassenger = true;
$taxi.passengerDest = 1;
colours.length = 0;
drawEdgeMarkers();
check("an off-screen destination is marked in the destination colour",
      colours.includes(C.hotYellow), `(${JSON.stringify(colours)})`);

LEVELS.pop();
$level = 0; $lives = 99; $state = "playing"; initLevel();

console.log("\n=== 10. draw() survives every state ===");
for (const s of ["title", "playing", "crashed", "levelComplete", "gameOver", "win"]) {
  $state = s;
  let threw = null;
  try { draw(); } catch (e) { threw = e.message; }
  check(`draw() in "${s}"`, threw === null, `(${threw})`);
}

console.log(fail.length ? `\n${fail.length} FAILING CHECK(S)` : "\nALL CHECKS PASSED");
process.exit(fail.length ? 1 : 0);
