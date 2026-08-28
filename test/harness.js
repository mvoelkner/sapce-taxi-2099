// Headless harness: runs the real game script against DOM stubs and exposes
// the IIFE internals so the new passenger/gear logic can be exercised.
// The environment itself lives in game-env.js, which the level extractor uses
// too — one loading path, so a test can never pass against a different build.
const {
  ROOT, fs, nodePath,
  ctxStub, canvasStub, explosionStub, explosionSoundStub,
  audioLog, vibrationLog, speechLog, timerQueue, flushTimers,
  sockets,
  hapticLog, installCapacitor, removeCapacitor,
} = require("./game-env.js");

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
function pushTestLevel(cols, rows, extra) {
  LEVELS.push(Object.assign({
    name: "TEST GRID",
    gravity: 0.04,
    cols, rows,
    pads: [
      { x: 60,                  y: 430,             w: 130, label: "1", color: "#55ff55" },
      { x: cols * 800 - 200,    y: rows * 500 - 70, w: 130, label: "2", color: "#70a4b2" },
      { x: 400,                 y: 300,             w: 130, label: "3", color: "#ffcc55" },
    ],
    fares: 1,
    obstacles: [],
    fuelStations: [],
  }, extra || {}));
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

console.log("\n=== 9l. HEY TAXI is announced twice, then falls silent ===");
$level = 0; $lives = 99; $state = "playing"; initLevel();
{
  // Hover clear of the pad so the fare stays in "waiting" for the whole run
  const seenShouts = [];
  const shoutFrames = [];
  for (let f = 0; f < 1200; f++) {          // 20 seconds
    $taxi.x = 400; $taxi.y = 100; $taxi.vx = 0; $taxi.vy = 0; $taxi.landed = false;
    update();
    for (const m of $messages) {
      if (m.text === "HEY TAXI!" && !seenShouts.includes(m)) {
        seenShouts.push(m);
        shoutFrames.push(f);
      }
    }
  }
  check("shouts exactly twice in twenty seconds",
        shoutFrames.length === 2, `(${shoutFrames.length} shouts at ${JSON.stringify(shoutFrames)})`);
  check("the first shout comes as the fare becomes ready",
        shoutFrames[0] === 0, `(frame ${shoutFrames[0]})`);
  check("the second follows five seconds later",
        shoutFrames[1] - shoutFrames[0] === 300, `(${shoutFrames[1] - shoutFrames[0]} frames apart)`);
  check("the fare still waits, so silence is not just delivery",
        $passengers[0].phase === "waiting", `(${$passengers[0].phase})`);
}
$level = 0; $lives = 99; $state = "playing"; initLevel();

console.log("\n=== 9m. Explosion overlay and sound ===");
{
  // The taxi body is a rect of exactly (w-4) x (h-6) at (x+2, y+4) — nothing
  // else the renderer emits has those dimensions, so it identifies the taxi.
  const rects = [];
  ctxStub.fillRect = (x, y, w, h) => rects.push({ x, y, w, h });
  const taxiDrawn = () => rects.some(r =>
    r.x === $taxi.x + 2 && r.y === $taxi.y + 4 &&
    r.w === $taxi.w - 4 && r.h === $taxi.h - 6);

  $level = 0; $lives = 99; $state = "playing"; initLevel();
  $viewScale = 1;
  $camera.x = 0; $camera.y = 0;
  $taxi.x = 300; $taxi.y = 200;

  rects.length = 0; draw();
  check("the taxi is drawn while playing", taxiDrawn(), "(no taxi body rect)");

  check("the overlay is hidden before any crash",
        !explosionStub.classList.contains("explosion--active"));

  explosionSoundStub.plays = 0;
  crash("TEST CRASH");

  check("crashing plays explosion.mp3",
        explosionSoundStub.plays === 1, `(${explosionSoundStub.plays} plays)`);
  check("crashing rewinds the sample so a second crash is heard",
        explosionSoundStub.currentTime === 0, `(${explosionSoundStub.currentTime})`);
  check("crashing shows the explosion overlay",
        explosionStub.classList.contains("explosion--active"));
  check("the overlay centre sits on the taxi",
        explosionStub.style.left === (300 + $taxi.w/2) + "px" &&
        explosionStub.style.top  === (200 + $taxi.h/2) + "px",
        `(${explosionStub.style.left},${explosionStub.style.top})`);

  rects.length = 0; draw();
  check("the taxi is gone once it has exploded", !taxiDrawn(), "(taxi body still drawn)");

  // A scaled-down window and a panned camera must both move the overlay
  $viewScale = 0.5;
  $camera.x = 100; $camera.y = 40;
  showExplosion(300, 200);
  check("the overlay follows camera and scale",
        explosionStub.style.left === ((300 - 100) * 0.5) + "px" &&
        explosionStub.style.top  === ((200 - 40) * 0.5) + "px",
        `(${explosionStub.style.left},${explosionStub.style.top})`);

  // Restarting the level has to clear it, or the wreck hangs over the new one
  $viewScale = 1;
  $level = 0; $lives = 99; $state = "playing"; initLevel();
  check("restarting the level hides the overlay",
        !explosionStub.classList.contains("explosion--active"));

  // Refuelling with a fare costs a life but is explicitly not a wreck
  explosionSoundStub.plays = 0;
  refuelViolation();
  check("refuelling with a fare aboard raises no explosion",
        explosionSoundStub.plays === 0 &&
        !explosionStub.classList.contains("explosion--active"),
        `(${explosionSoundStub.plays} plays)`);

  // The iOS unlock has to leave the element silent and rewound. An earlier
  // section already unlocked audio, so the guard has to be reset to test it.
  $explosionPrimed = false;
  explosionSoundStub.plays = 0;
  explosionSoundStub.paused = false;
  explosionSoundStub.muted = false;
  primeExplosionSound();
  check("priming plays the sample once to satisfy the iOS gesture rule",
        explosionSoundStub.plays === 1, `(${explosionSoundStub.plays} plays)`);
  check("priming leaves the sample paused, rewound and audible",
        explosionSoundStub.paused && explosionSoundStub.currentTime === 0 &&
        explosionSoundStub.muted === false,
        `(paused=${explosionSoundStub.paused}, t=${explosionSoundStub.currentTime}, muted=${explosionSoundStub.muted})`);
  const primedPlays = explosionSoundStub.plays;
  primeExplosionSound();
  check("priming happens only once",
        explosionSoundStub.plays === primedPlays, `(${explosionSoundStub.plays} vs ${primedPlays})`);
}
$level = 0; $lives = 99; $state = "playing"; initLevel();

console.log("\n=== 9n. Fare board ===");
{
  const live = () => $passengers.filter(p =>
    p.phase === "waiting" || p.phase === "boarding").length;
  const phases = () => $passengers.map(p => p.phase).join(",");

  // ── Single player must come out of this untouched ──
  $level = 0; $lives = 99; $state = "playing"; initLevel();
  check("single player still starts with exactly one fare",
        live() === 1, `(${phases()})`);
  check("the default policy is one fare, refilled after delivery, without delay",
        farePolicy(LEVELS[0]).activeFares === 1 &&
        farePolicy(LEVELS[0]).refillOn === "delivered" &&
        farePolicy(LEVELS[0]).refillDelay === 0,
        `(${JSON.stringify(farePolicy(LEVELS[0]))})`);

  // Board the first fare; single player must NOT put a second one out yet
  const first = $passengers[0];
  parkOn(first.padIndex, clearSpotOn(first.padIndex));
  for (let i = 0; i < 200 && first.phase !== "aboard"; i++) update();
  check("the first fare boards", first.phase === "aboard", `(${first.phase})`);
  check("single player puts out no second fare while one is aboard",
        live() === 0, `(${phases()})`);

  // ── The economy level ──
  const ecoIdx = pushTestLevel(2, 2, {
    fares: 3, activeFares: 3, refillOn: "aboard", refillDelay: 60,
  });
  $level = ecoIdx; $lives = 99; $state = "playing"; initLevel();

  check("an economy level puts its whole base count out at once",
        live() === 3, `(${phases()})`);
  check("the board fills without waiting out the refill delay",
        $passengers.filter(p => p.phase === "queued").length === 0, `(${phases()})`);

  // Pick one up and watch the slot refill
  const rider = $passengers.find(p => p.phase === "waiting");
  parkOn(rider.padIndex, clearSpotOn(rider.padIndex));
  for (let i = 0; i < 200 && rider.phase !== "aboard"; i++) update();
  check("a fare can be picked up on an economy level",
        rider.phase === "aboard", `(${rider.phase})`);

  const beforeRefill = live();
  for (let i = 0; i < 55; i++) update();
  check("the replacement does not appear before the delay is up",
        live() === beforeRefill, `(${live()} live after 55 frames, was ${beforeRefill})`);
  for (let i = 0; i < 20; i++) update();
  check("the replacement appears once the delay is up",
        live() === beforeRefill + 1, `(${live()} live, was ${beforeRefill})`);

  // ── The supply must not run dry ──
  const poolBefore = $passengers.length;
  check("the pool grew past the level's own fare count",
        poolBefore > 3, `(${poolBefore} fares from a pool of 3)`);
  check("an economy level does not report levelComplete",
        $state === "playing", `(${$state})`);

  // ── One taxi carries one fare: two on a pad, only one boards ──
  $level = ecoIdx; $lives = 99; $state = "playing"; initLevel();
  const shared = $pads[2];
  const [a, b] = $passengers.filter(p => p.phase === "waiting").slice(0, 2);
  a.padIndex = 2; b.padIndex = 2;
  a.x = shared.x + 20;
  b.x = shared.x + shared.w - 20;
  parkOn(2, shared.x + shared.w/2 - $taxi.w/2);
  update();
  const boarding = [a, b].filter(p => p.phase === "boarding");
  check("only one of two fares on a pad starts boarding",
        boarding.length === 1, `(${a.phase}/${b.phase})`);
  check("the taxi records which fare claimed it",
        $taxi.fareClaim === boarding[0].index, `(${$taxi.fareClaim} vs ${boarding[0].index})`);

  for (let i = 0; i < 200 && boarding[0].phase !== "aboard"; i++) update();
  check("the claimed fare boards and the other stays put",
        boarding[0].phase === "aboard" &&
        [a, b].filter(p => p.phase === "waiting").length === 1,
        `(${a.phase}/${b.phase})`);
  check("boarding releases the claim",
        $taxi.fareClaim === -1, `(${$taxi.fareClaim})`);

  // ── Flying off mid-boarding hands the claim back ──
  $level = ecoIdx; $lives = 99; $state = "playing"; initLevel();
  const solo = $passengers.find(p => p.phase === "waiting");
  parkOn(solo.padIndex, clearSpotOn(solo.padIndex));
  update();
  check("landing beside a fare claims the taxi",
        $taxi.fareClaim === solo.index, `(${$taxi.fareClaim})`);
  $taxi.landed = false; $taxi.landedPad = -1; $taxi.y -= 40;
  update();
  check("leaving the pad releases the claim",
        $taxi.fareClaim === -1 && solo.phase === "waiting",
        `(claim=${$taxi.fareClaim}, phase=${solo.phase})`);

  LEVELS.pop();
}
$level = 0; $lives = 99; $state = "playing"; initLevel();

console.log("\n=== 9o. Mode selection ===");
{
  const press = () => { input.action = true; handleInput(); };
  const nudge = dir => {
    input.left = input.right = false;
    input[dir] = true; handleInput();
    input[dir] = false; handleInput();     // release, so the latch can re-arm
  };

  bootGame();
  check("the game boots into the mode menu", $state === "menu", `(${$state})`);
  check("single player is preselected", $menuIndex === 0, `(${$menuIndex})`);
  check("no mode is committed before a choice", $gameMode === "single", `(${$gameMode})`);

  nudge("right");
  check("steering right moves to multiplayer", $menuIndex === 1, `(${$menuIndex})`);
  nudge("right");
  check("the selection stops at the last entry", $menuIndex === 1, `(${$menuIndex})`);
  nudge("left");
  check("steering left moves back", $menuIndex === 0, `(${$menuIndex})`);
  nudge("left");
  check("the selection stops at the first entry", $menuIndex === 0, `(${$menuIndex})`);

  // A held direction must not run the selection along. With only two entries the
  // clamp would hide a runaway cursor, so count the move sound instead.
  $menuIndex = 0;
  input.right = false; handleInput();        // disarm the latch
  audioLog.sources = 0;
  input.right = true;
  handleInput(); handleInput(); handleInput();
  input.right = false; handleInput();
  check("holding a direction moves the selection once, not every frame",
        audioLog.sources === 1, `(${audioLog.sources} cursor moves)`);

  // ── Multiplayer is offered but has no server yet ──
  press();
  check("choosing multiplayer records the mode", $gameMode === "multi", `(${$gameMode})`);
  check("choosing multiplayer goes to the lobby, not into a game",
        $state === "lobby", `(${$state})`);
  netDisconnect();

  // ── Single player must reach the old title flow untouched ──
  bootGame();
  press();
  check("choosing single player goes to the title screen",
        $state === "title", `(${$state})`);
  check("single player stays the committed mode", $gameMode === "single", `(${$gameMode})`);
  press();
  check("the title screen still starts the game", $state === "playing", `(${$state})`);
  check("starting from the title gives the usual three lives",
        $lives === 3, `(${$lives})`);
  check("and starts on the first level", $level === 0, `(${$level})`);

  // ── Game over returns to the menu, not straight into a new run ──
  $state = "gameOver";
  press();
  check("game over leads back to the mode menu", $state === "menu", `(${$state})`);
}
$level = 0; $lives = 99; $state = "playing"; initLevel();

console.log("\n=== 9p. Level data for the server ===");
{
  const extractor = require("../scripts/extract-levels.js");
  const onDisk = fs.existsSync(extractor.OUT)
    ? fs.readFileSync(extractor.OUT, "utf8") : null;
  check("the committed levels.json matches index.html",
        onDisk === extractor.render(),
        "(run: node scripts/extract-levels.js)");

  const data = extractor.build();
  check("it carries every level", data.levels.length === LEVELS.length,
        `(${data.levels.length} of ${LEVELS.length})`);
  check("pad geometry crosses over intact",
        data.levels.every((l, i) => l.pads.every((p, j) =>
          p.x === LEVELS[i].pads[j].x &&
          p.y === LEVELS[i].pads[j].y &&
          p.w === LEVELS[i].pads[j].w)),
        "(a pad drifted from the client's own definition)");
  check("world size is resolved, not left as a grid to recompute",
        data.levels.every(l => l.worldW === l.cols * SECTOR_W &&
                               l.worldH === l.rows * SECTOR_H));
  check("the fare policy travels with the level",
        data.levels.every(l => l.policy.activeFares >= 1 && l.policy.refillOn));
  check("physics stays on the client",
        data.levels.every(l =>
          l.gravity === undefined && l.obstacles === undefined &&
          l.fuelStations === undefined),
        "(the server has no business knowing these)");
}

console.log("\n=== 9q. Talking to the server ===");
{
  // A room snapshot in the shape the server actually sends
  const snapshot = (over = {}) => Object.assign({
    phase: "running", winner: null, level: 0,
    cols: 2, rows: 2, world_w: 1600, world_h: 1000,
    pads: LEVELS[0].pads.map((p, i) => ({ index: i, x: p.x, y: p.y, w: p.w, label: p.label })),
    players: { me: { name: "ME", lives: 3, score: 0, alive: true } },
    fares: { f0: { from: 0, to: 1, claimed_by: null } },
  }, over);

  // Walk a socket all the way to a joined room
  const handshake = (over) => {
    netDisconnect();
    sockets.length = 0;
    netConnect("testroom");
    const ws = sockets[sockets.length - 1];
    ws.open();
    const join = ws.lastOf("phx_join");
    ws.deliver([join[0], join[1], join[2], "phx_reply", {
      status: "ok",
      response: { player_id: "me", schema: 1, state: snapshot(over) },
    }]);
    return ws;
  };

  netDisconnect();
  sockets.length = 0;

  check("nothing is connected to start with", $netState === "idle", `(${$netState})`);

  netConnect("testroom");
  const ws = sockets[sockets.length - 1];
  check("connecting opens exactly one socket", sockets.length === 1, `(${sockets.length})`);
  check("the url is derived from where the page is served",
        ws.url.startsWith("ws://game.test/socket/websocket"), `(${ws.url})`);

  check("the protocol version is pinned", ws.url.includes("vsn=2.0.0"), `(${ws.url})`);
  check("it reports itself as connecting", $netState === "connecting", `(${$netState})`);

  ws.open();
  check("opening sends a join", !!ws.lastOf("phx_join"), `(${JSON.stringify(ws.frames())})`);
  check("it joins the room it was asked for",
        ws.lastOf("phx_join")[2] === "room:testroom", `(${ws.lastOf("phx_join")[2]})`);
  check("it waits for the reply before calling itself joined",
        $netState === "joining", `(${$netState})`);

  const join = ws.lastOf("phx_join");
  ws.deliver([join[0], join[1], join[2], "phx_reply", {
    status: "ok",
    response: { player_id: "me", schema: 1, state: snapshot() },
  }]);
  check("the join reply completes the handshake", $netState === "joined", `(${$netState})`);
  check("it remembers its own id", $myPlayerId === "me", `(${$myPlayerId})`);
  check("and keeps the room state", $roomState && $roomState.world_w === 1600,
        `(${JSON.stringify($roomState && $roomState.world_w)})`);

  // ── A refused join must not look like a connected one ──
  netDisconnect();
  sockets.length = 0;
  netConnect("bad room");
  const bad = sockets[sockets.length - 1];
  bad.open();
  const badJoin = bad.lastOf("phx_join");
  bad.deliver([badJoin[0], badJoin[1], badJoin[2], "phx_reply", {
    status: "error", response: { reason: "bad_room_name" },
  }]);
  check("a refused join lands in failed, not joined", $netState === "failed", `(${$netState})`);
  check("and the reason is kept, ready to be shown",
        $netError === "BAD_ROOM_NAME", `(${$netError})`);

  // ── A dropped socket must be visible, not silently pretended away ──
  const dropped = handshake();
  dropped.close();
  check("a closed socket ends the session", $netState === "closed", `(${$netState})`);

  // ── Remote players ──
  const w = handshake({
    players: {
      me:    { name: "ME",   lives: 3, score: 0, alive: true },
      other: { name: "THEM", lives: 3, score: 0, alive: true },
    },
  });
  check("the other player is picked up from the state",
        $remotes.has("other"), `(${[...$remotes.keys()]})`);
  check("but not myself — my own taxi is simulated, not received",
        !$remotes.has("me"), `(${[...$remotes.keys()]})`);

  w.deliver([null, null, "room:testroom", "pos",
             { id: "other", x: 400, y: 300, vx: 1, vy: 0, a: 0, g: 1, t: 0 }]);
  const other = $remotes.get("other");
  check("a position update is taken", other.tx === 400 && other.ty === 300,
        `(${other.tx},${other.ty})`);
  check("the first update snaps rather than gliding in from nowhere",
        other.x === 400 && other.y === 300, `(${other.x},${other.y})`);

  w.deliver([null, null, "room:testroom", "pos",
             { id: "other", x: 500, y: 300, vx: 1, vy: 0, a: 0, g: 1, t: 0 }]);
  check("a later update is a target, not a jump",
        other.x > 400 && other.x < 500, `(x=${other.x})`);
  const before = other.x;
  updateRemotes();
  check("and the drawn position closes on it",
        other.x > before && other.x <= 500, `(${before} -> ${other.x})`);

  // ── My own position goes out, but not on every frame ──
  $level = 0; $lives = 99; $state = "playing"; initLevel();
  $taxi.x = 111; $taxi.y = 222;
  w.sent.length = 0;
  for (let i = 0; i < 60; i++) netTick();
  const posFrames = w.frames().filter(f => f[3] === "pos");
  check("positions are sent at about 15 Hz, not 60",
        posFrames.length >= 12 && posFrames.length <= 18,
        `(${posFrames.length} in 60 frames)`);
  check("the position sent is the taxi's own",
        posFrames.length > 0 && posFrames[0][4].x === 111, `(${JSON.stringify(posFrames[0])})`);

  // ── Heartbeat, or an idle socket gets cut by the ingress ──
  w.sent.length = 0;
  for (let i = 0; i < 60 * 31; i++) netHeartbeat();
  const beats = w.frames().filter(f => f[3] === "heartbeat");
  check("a heartbeat goes out inside the 60s ingress window",
        beats.length >= 1, `(${beats.length} in 31s)`);
  check("the heartbeat uses the phoenix topic",
        beats.length > 0 && beats[0][2] === "phoenix", `(${beats[0] && beats[0][2]})`);

  // It must not depend on the simulation running: update() bails out in every
  // state but "playing", and those quiet stretches are the whole reason the
  // heartbeat exists. A wrecked player left waiting loses the socket otherwise.
  for (const idle of ["crashed", "levelComplete", "gameOver"]) {
    $state = idle;
    w.sent.length = 0;
    for (let i = 0; i < 60 * 31; i++) { update(); netHeartbeat(); }
    check(`the heartbeat survives "${idle}"`,
          w.frames().some(f => f[3] === "heartbeat"),
          `(${JSON.stringify(w.frames().map(f => f[3]))})`);
  }
  $state = "playing";

  // ── Where the URL comes from when there is no origin to derive it from ──
  {
    const before = globalThis.location.protocol;
    const realQuery = globalThis.document.querySelector;
    const openTo = () => {
      netDisconnect(); sockets.length = 0;
      netConnect("r");
      const s = sockets[sockets.length - 1];
      return (s && s.url) || "";
    };

    // Inside the native shell the page comes from the app bundle, so its own
    // origin is not a server. Deriving from it would give ws://localhost/.
    globalThis.location.protocol = "capacitor:";
    check("a native origin falls back rather than pointing at itself",
          openTo().startsWith("ws://localhost:4000/"), `(${openTo()})`);

    globalThis.location.protocol = "file:";
    check("so does file://", openTo().startsWith("ws://localhost:4000/"), `(${openTo()})`);

    // The package build bakes the real address into the copied index.html,
    // because an app never launches with a query string.
    globalThis.document.querySelector = sel =>
      sel === 'meta[name="taxi-server"]'
        ? { getAttribute: () => "wss://taxi.example/socket/websocket" } : null;
    check("a baked-in address wins over the fallback",
          openTo().startsWith("wss://taxi.example/"), `(${openTo()})`);

    globalThis.location.protocol = "https:";
    check("and over deriving from the origin",
          openTo().startsWith("wss://taxi.example/"), `(${openTo()})`);

    globalThis.location.search = "?server=ws%3A%2F%2Fforced.test%2Fsock";
    check("but ?server= still beats everything",
          openTo().startsWith("ws://forced.test/sock"), `(${openTo()})`);

    globalThis.location.search = "";
    globalThis.document.querySelector = realQuery;
    globalThis.location.protocol = before;
  }

  netDisconnect();
  sockets.length = 0;
  $level = 0; $lives = 99; $state = "playing"; initLevel();
}

console.log("\n=== 9r. Playing online ===");
{
  const padsOf = li => LEVELS[li].pads.map((p, i) =>
    ({ index: i, x: p.x, y: p.y, w: p.w, label: p.label }));

  const snapshot = (over = {}) => Object.assign({
    phase: "running", winner: null, level: 0,
    cols: 2, rows: 2, world_w: 1600, world_h: 1000,
    pads: padsOf(0),
    players: { me: { name: "ME", lives: 3, score: 0, alive: true } },
    fares: { f0: { from: 0, to: 1, claimed_by: null } },
  }, over);

  const goOnline = (over) => {
    netDisconnect();
    sockets.length = 0;
    bootGame();
    $menuIndex = 1;
    input.action = true;
    handleInput();                       // choosing MULTIPLAYER
    const ws = sockets[sockets.length - 1];
    ws.open();
    const join = ws.lastOf("phx_join");
    ws.deliver([join[0], join[1], join[2], "phx_reply", {
      status: "ok",
      response: { player_id: "me", schema: 1, state: snapshot(over) },
    }]);
    return ws;
  };

  // ── The menu now opens a connection instead of apologising ──
  netDisconnect();
  sockets.length = 0;
  bootGame();
  $menuIndex = 1;
  input.action = true;
  handleInput();
  check("choosing multiplayer opens a connection",
        sockets.length === 1, `(${sockets.length} sockets)`);
  check("and shows a lobby while it waits", $state === "lobby", `(${$state})`);

  // ── A server that is not there must not strand the player ──
  sockets[0].fail();
  check("a failed connection stays in the lobby to say so",
        $state === "lobby" && $netState === "failed", `(${$state}/${$netState})`);
  input.action = true; handleInput();
  check("and a press gets back to the menu", $state === "menu", `(${$state})`);
  check("leaving the lobby drops the socket", $netState === "idle", `(${$netState})`);

  // ── A good join starts the game ──
  const ws = goOnline();
  check("a successful join starts playing", $state === "playing", `(${$state})`);
  check("online play uses the world the server sent",
        $worldW === 1600 && $worldH === 1000, `(${$worldW}x${$worldH})`);
  check("single player levels are untouched by that",
        LEVELS[0].cols === 1 && LEVELS[0].rows === 1);

  // ── Fares come from the server, not from the local generator ──
  check("the server's fare is on the board",
        $passengers.length === 1 && $passengers[0].fareId === "f0",
        `(${JSON.stringify($passengers.map(p => p.fareId))})`);
  check("it stands on the pad the server named",
        $passengers[0].padIndex === 0, `(${$passengers[0].padIndex})`);
  check("and is headed where the server said",
        $passengers[0].destPadIndex === 1, `(${$passengers[0].destPadIndex})`);

  // Two clients must place the same fare in the same spot, or players would
  // aim at a passenger standing somewhere else on the other screen.
  const firstX = $passengers[0].x;
  const w2 = goOnline();
  check("the stand position is derived from the fare id, so every client agrees",
        $passengers[0].x === firstX, `(${firstX} vs ${$passengers[0].x})`);

  // ── Picking up asks the server first ──
  parkOn(0, clearSpotOn(0));
  w2.sent.length = 0;
  update();
  const claim = w2.lastOf("claim");
  check("landing beside a fare sends a claim", !!claim, `(${JSON.stringify(w2.frames())})`);
  check("the claim names the server's fare id",
        claim && claim[4].fare === "f0", `(${JSON.stringify(claim && claim[4])})`);
  check("boarding waits for the answer",
        $passengers[0].phase === "claiming", `(${$passengers[0].phase})`);

  w2.sent.length = 0;
  update();
  check("and the claim is not sent again while it is pending",
        !w2.lastOf("claim"), `(${JSON.stringify(w2.frames())})`);

  // Someone else was quicker
  w2.deliver([null, claim[1], "room:testroom", "phx_reply",
              { status: "error", response: { reason: "taken" } }]);
  check("a refused claim takes the fare off this board",
        $passengers.length === 0 || $passengers[0].phase !== "claiming",
        `(${JSON.stringify($passengers.map(p => p.phase))})`);

  // ── An accepted claim lets the passenger board ──
  const w3 = goOnline();
  parkOn(0, clearSpotOn(0));
  update();
  const ok = w3.lastOf("claim");
  w3.deliver([null, ok[1], "room:testroom", "phx_reply", { status: "ok", response: {} }]);
  check("an accepted claim starts the passenger walking",
        $passengers[0].phase === "boarding", `(${$passengers[0].phase})`);
  for (let i = 0; i < 300 && !$taxi.hasPassenger; i++) update();
  check("and they get in", $taxi.hasPassenger, `(${$passengers[0].phase})`);

  // ── Delivering reports to the server ──
  w3.sent.length = 0;
  parkOn(1);
  update();
  const deliver = w3.lastOf("deliver");
  check("dropping off reports the delivery", !!deliver, `(${JSON.stringify(w3.frames())})`);
  check("with the fare and the pad",
        deliver && deliver[4].fare === "f0" && deliver[4].pad === 1,
        `(${JSON.stringify(deliver && deliver[4])})`);

  // ── Taxi against taxi ──
  const w4 = goOnline({
    players: {
      me:    { name: "ME",   lives: 3, score: 0, alive: true },
      other: { name: "THEM", lives: 3, score: 0, alive: true },
    },
  });
  $taxi.x = 400; $taxi.y = 300; $taxi.vx = 0; $taxi.vy = 0; $taxi.landed = false;
  // Far away and slow: nothing to report
  w4.deliver([null, null, "room:testroom", "pos", { id: "other", x: 900, y: 300 }]);
  w4.sent.length = 0;
  update();
  check("a distant taxi is not a collision", !w4.lastOf("collide"));

  // Touching but barely moving: a nudge at the pad must not cost a life.
  // Delivered repeatedly, the way the server would at 15 Hz — the drawn
  // position eases towards its target rather than teleporting, and collisions
  // are checked against what is drawn.
  const park = (x, vx) => {
    for (let i = 0; i < 30; i++) {
      w4.deliver([null, null, "room:testroom", "pos",
                  { id: "other", x, y: $taxi.y, vx, vy: 0 }]);
      updateRemotes();
    }
  };
  $taxi.landed = false;
  park($taxi.x + 10, 0.1);
  w4.sent.length = 0;
  update();
  check("touching gently is not a collision either",
        !w4.lastOf("collide"), `(${JSON.stringify(w4.frames())})`);

  // Touching at speed
  $taxi.landed = false;
  $taxi.vx = 4;
  park($taxi.x + 10, -4);
  w4.sent.length = 0;
  update();
  const collide = w4.lastOf("collide");
  check("a real bump is reported", !!collide, `(${JSON.stringify(w4.frames())})`);
  check("and it names the other player",
        collide && collide[4].with === "other", `(${JSON.stringify(collide && collide[4])})`);
  check("the bump is not reported twice in a row",
        (() => { w4.sent.length = 0; update(); return !w4.lastOf("collide"); })());

  // ── Lives come from the server, not from the local counter ──
  const w5 = goOnline();
  check("lives start from the server's number", $lives === 3, `(${$lives})`);
  w5.deliver([null, null, "room:testroom", "state",
              snapshot({ players: { me: { name: "ME", lives: 1, score: 70, alive: true } } })]);
  check("a server state sets the lives", $lives === 1, `(${$lives})`);
  check("and the score", $score === 70, `(${$score})`);

  // ── The round ends when the server says so, not when the board is empty ──
  w5.deliver([null, null, "room:testroom", "state",
              snapshot({ phase: "over", winner: "me",
                         players: { me: { name: "ME", lives: 1, score: 500, alive: true } } })]);
  check("the server ending the round ends it here", $state === "gameOver", `(${$state})`);

  // ── A crash online tells the server ──
  const w6 = goOnline();
  w6.sent.length = 0;
  crash("TEST");
  check("crashing online reports it", !!w6.lastOf("crashed"), `(${JSON.stringify(w6.frames())})`);
  check("but the local life counter does not also drop it",
        $lives === 3, `(${$lives})`);
  check("crashing leaves the wreck state, not game over",
        $state === "crashed", `(${$state})`);

  // The state that follows the crash is the one carrying the life it cost, so
  // it has to be taken while wrecked — not only while flying.
  w6.deliver([null, null, "room:testroom", "state",
              snapshot({ players: { me: { name: "ME", lives: 2, score: 0, alive: true } } })]);
  check("the life the server took is applied while wrecked",
        $lives === 2, `(${$lives})`);

  // And a player with no lives waits for the round rather than being ejected
  w6.deliver([null, null, "room:testroom", "state",
              snapshot({ players: { me: { name: "ME", lives: 0, score: 0, alive: false } } })]);
  check("running out of lives does not end the round on its own",
        $state === "crashed" && $lives === 0, `(${$state}/${$lives})`);
  w6.deliver([null, null, "room:testroom", "state",
              snapshot({ phase: "over", winner: "other",
                         players: { me: { name: "ME", lives: 0, score: 0, alive: false } } })]);
  check("the round ending gets them out of the wreck screen",
        $state === "gameOver", `(${$state})`);

  // ── The other players have to actually appear on screen ──
  const w7 = goOnline({
    players: {
      me:    { name: "ME",   lives: 3, score: 10, alive: true },
      other: { name: "THEM", lives: 3, score: 90, alive: true },
    },
  });
  const texts = [];
  ctxStub.fillText = t => texts.push(String(t));
  $camera.x = 0; $camera.y = 0;

  texts.length = 0;
  draw();
  check("an unseen player is not drawn before their first position",
        !texts.includes("THEM"), `(${JSON.stringify(texts)})`);

  w7.deliver([null, null, "room:testroom", "pos",
              { id: "other", x: 300, y: 200, g: 1, t: 1 }]);
  texts.length = 0;
  draw();
  check("once positioned, the other taxi is labelled with its pilot",
        texts.includes("THEM"), `(${JSON.stringify(texts)})`);
  check("the standings show both players and their scores",
        texts.some(t => t === "ME 10") && texts.some(t => t === "THEM 90"),
        `(${JSON.stringify(texts)})`);
  check("the offline fare counter is replaced, not stacked on top",
        !texts.some(t => t.startsWith("FARES:")), `(${JSON.stringify(texts)})`);

  // A player who is out must stop being drawn as a flying taxi
  w7.deliver([null, null, "room:testroom", "state",
              snapshot({ players: {
                me:    { name: "ME",   lives: 3, score: 10, alive: true },
                other: { name: "THEM", lives: 0, score: 90, alive: false },
              } })]);
  texts.length = 0;
  draw();
  check("a player who is out is no longer flying around",
        !texts.includes("THEM"), `(${JSON.stringify(texts)})`);
  check("but is still listed, marked out",
        texts.some(t => t === "THEM 90 OUT"), `(${JSON.stringify(texts)})`);

  // ── Single player must be completely unaffected ──
  netDisconnect();
  sockets.length = 0;
  bootGame();
  $menuIndex = 0;
  input.action = true; handleInput();     // SINGLE PLAYER
  check("single player opens no socket", sockets.length === 0, `(${sockets.length})`);
  input.action = true; handleInput();     // start
  check("and still starts a normal run",
        $state === "playing" && $lives === 3 && $level === 0,
        `(${$state}/${$lives}/${$level})`);
  check("with a locally generated fare",
        $passengers.length > 0 && $passengers[0].fareId === undefined,
        `(${$passengers[0] && $passengers[0].fareId})`);
  check("crashing offline still costs a local life",
        (() => { crash("TEST"); return $lives === 2; })(), `(${$lives})`);

  netDisconnect();
  sockets.length = 0;
  $level = 0; $lives = 99; $state = "playing"; initLevel();
}

console.log("\n=== 9s. Haptics on both backends ===");
{
  // ── The web backend must be exactly what it always was ──
  removeCapacitor();
  $level = 0; $lives = 99; $state = "playing"; initLevel();

  const webPattern = fn => { vibrationLog.length = 0; fn(); return vibrationLog[0]; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  check("a soft landing still buzzes as before",
        same(webPattern(() => touchdownFeedback(0.5)), [18]),
        `(${JSON.stringify(vibrationLog)})`);
  check("a hard landing still buzzes as before",
        same(webPattern(() => touchdownFeedback(1.5)), [55]),
        `(${JSON.stringify(vibrationLog)})`);
  check("a crash still buzzes as before",
        same(webPattern(() => haptic(HAPTICS.crash)), [60, 40, 120]),
        `(${JSON.stringify(vibrationLog)})`);
  check("the refuel penalty still buzzes as before",
        same(webPattern(() => haptic(HAPTICS.penalty)), [180]),
        `(${JSON.stringify(vibrationLog)})`);
  check("the fuel warning still buzzes as before",
        same(webPattern(() => haptic(HAPTICS.fuelWarn)), [30, 70, 30]),
        `(${JSON.stringify(vibrationLog)})`);
  check("the shout still buzzes as before",
        same(webPattern(() => haptic(HAPTICS.shout)), [25, 50, 25]),
        `(${JSON.stringify(vibrationLog)})`);

  // ── Native backend ──
  installCapacitor();
  const native = fn => { hapticLog.length = 0; vibrationLog.length = 0; fn(); return hapticLog; };

  check("a crash reaches the taptic engine",
        native(() => haptic(HAPTICS.crash)).length === 1,
        `(${JSON.stringify(hapticLog)})`);
  check("and reports as an error, not a tap",
        hapticLog[0].call === "notification" && hapticLog[0].type === "ERROR",
        `(${JSON.stringify(hapticLog[0])})`);
  check("it does not also call navigator.vibrate",
        vibrationLog.length === 0, `(${JSON.stringify(vibrationLog)})`);

  check("a soft landing is a light tap",
        native(() => touchdownFeedback(0.5))[0].call === "impact" &&
        hapticLog[0].style === "LIGHT", `(${JSON.stringify(hapticLog)})`);
  check("a hard landing is a heavier one",
        native(() => touchdownFeedback(1.5))[0].style === "MEDIUM",
        `(${JSON.stringify(hapticLog)})`);
  check("the refuel penalty is a warning",
        native(() => haptic(HAPTICS.penalty))[0].type === "WARNING",
        `(${JSON.stringify(hapticLog)})`);

  // ── The sustained rumble ──
  // Run this with navigator.vibrate taken away, because that is the actual iOS
  // shape: the API is absent there. With the stub's vibrate still in place the
  // check would pass through the web path and prove nothing about the platform
  // the native build exists for.
  const realNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: {}, configurable: true, writable: true,
  });

  hapticLog.length = 0;
  stopRumble();
  for (let i = 0; i < 40; i++) setThrustHaptics(true);
  check("thrust rumbles on a platform with no navigator.vibrate",
        hapticLog.length > 0, `(${hapticLog.length} pulses in 40 steps)`);
  check("it pulses rather than firing every frame",
        hapticLog.length <= 5, `(${hapticLog.length} pulses in 40 steps)`);
  setThrustHaptics(false);
  check("letting go stops it", $rumbling === false);

  // And with neither backend there must be no rumble and no crash
  removeCapacitor();
  hapticLog.length = 0;
  stopRumble();
  for (let i = 0; i < 40; i++) setThrustHaptics(true);
  check("with no haptics at all it stays quiet",
        hapticLog.length === 0 && $rumbling === false,
        `(${hapticLog.length} pulses, rumbling=${$rumbling})`);

  installCapacitor();
  Object.defineProperty(globalThis, "navigator", {
    value: realNavigator, configurable: true, writable: true,
  });

  // ── An unusable plugin must not take the game down ──
  window.Capacitor.Plugins.Haptics = {
    impact: () => { throw new Error("plugin exploded"); },
    notification: () => { throw new Error("plugin exploded"); },
  };
  let threw = null;
  try { haptic(HAPTICS.crash); touchdownFeedback(2); } catch (e) { threw = e.message; }
  check("a plugin that throws does not reach the game", threw === null, `(${threw})`);

  // The real plugin methods return promises, and a rejection escapes try/catch
  // entirely — it would surface as an unhandled rejection instead.
  let rejections = 0;
  const rejected = () => ({ catch: fn => { rejections++; fn(new Error("no engine")); } });
  window.Capacitor.Plugins.Haptics = {
    impact: rejected,
    notification: rejected,
  };
  threw = null;
  try { haptic(HAPTICS.crash); touchdownFeedback(0.2); } catch (e) { threw = e.message; }
  check("a rejected plugin promise is handled, not left dangling",
        threw === null && rejections === 2, `(${threw}, ${rejections} handled)`);

  removeCapacitor();
  $level = 0; $lives = 99; $state = "playing"; initLevel();
}

console.log("\n=== 9t. Service worker registration ===");
{
  const swLog = [];
  const withSW = (over = {}) => {
    swLog.length = 0;
    globalThis.navigator.serviceWorker = {
      register: (url, opts) => {
        swLog.push({ url, opts });
        return { then: (ok) => { ok && ok({ scope: "./" }); return { catch: () => {} }; },
                 catch: () => {} };
      },
    };
    Object.assign(globalThis.location, over);
  };
  const origin = { protocol: globalThis.location.protocol };

  withSW({ protocol: "https:" });
  registerServiceWorker();
  check("it registers over https", swLog.length === 1, `(${JSON.stringify(swLog)})`);
  check("and points at sw.js", swLog[0] && /sw\.js$/.test(swLog[0].url),
        `(${swLog[0] && swLog[0].url})`);

  withSW({ protocol: "http:" });
  registerServiceWorker();
  check("it registers on plain http too, for localhost", swLog.length === 1);

  // A service worker cannot be registered from file://, and trying throws
  withSW({ protocol: "file:" });
  let threw = null;
  try { registerServiceWorker(); } catch (e) { threw = e.message; }
  check("it does not try under file://", swLog.length === 0, `(${JSON.stringify(swLog)})`);
  check("and does not throw there", threw === null, `(${threw})`);

  // Inside the native shell the app is loaded from the bundle; a worker there
  // would cache the very files Capacitor is already serving locally.
  withSW({ protocol: "https:" });
  installCapacitor();
  registerServiceWorker();
  check("it stays out of the native build", swLog.length === 0, `(${JSON.stringify(swLog)})`);
  removeCapacitor();

  // A browser without support must not break the page
  withSW({ protocol: "https:" });
  delete globalThis.navigator.serviceWorker;
  threw = null;
  try { registerServiceWorker(); } catch (e) { threw = e.message; }
  check("an unsupporting browser is simply skipped", threw === null, `(${threw})`);

  Object.assign(globalThis.location, origin);
}

console.log("\n=== 10. draw() survives every state ===");
for (const s of ["menu", "lobby", "title", "playing", "crashed", "levelComplete", "gameOver", "win"]) {
  $state = s;
  let threw = null;
  try { draw(); } catch (e) { threw = e.message; }
  check(`draw() in "${s}"`, threw === null, `(${threw})`);
}

console.log(fail.length ? `\n${fail.length} FAILING CHECK(S)` : "\nALL CHECKS PASSED");
process.exit(fail.length ? 1 : 0);
