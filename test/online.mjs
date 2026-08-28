// Two copies of the real game, driven headlessly against a real running server.
//
// The harness proves the client against a stubbed socket and the ExUnit suite
// proves the server against stubbed clients. Neither catches a disagreement
// between the two — a field the client reads and the server never sends would
// pass both. So this loads index.html twice, points both at a live server, and
// plays a fare from one client to the other.
//
//   scripts/mix.sh phx.server        # in another terminal
//   node test/online.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

const require = createRequire(import.meta.url);
const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = process.env.TAXI_SERVER || "ws://localhost:4000/socket/websocket";
const ROOM = "onl" + Math.floor(Math.random() * 1e6);

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name} ${cond ? "" : detail}`);
};
const wait = ms => new Promise(r => setTimeout(r, ms));

// Each client is the real game script in its own sandbox, with the same DOM
// stubs the harness uses but a real WebSocket underneath.
function spawnClient(label) {
  const fs = require("node:fs");
  const html = fs.readFileSync(nodePath.join(ROOT, "index.html"), "utf8");
  let js = html.split("<script>")[1].split("</script>")[0];

  const exported = [
    "handleInput", "bootGame", "update", "draw", "initLevel", "netDisconnect",
    "netFrame", "updateRemotes", "updateCamera",
    "get $camera(){return camera}",
    "LEVELS", "GEAR_LEN", "PERSON_HALF_W", "input",
    "get $state(){return state}", "set $state(v){state=v}",
    "get $netState(){return netState}", "get $netError(){return netError}",
    "get $taxi(){return taxi}", "get $pads(){return pads}",
    "get $passengers(){return passengers}", "get $remotes(){return remotes}",
    "get $roomState(){return roomState}", "get $myPlayerId(){return myPlayerId}",
    "get $worldW(){return worldW}", "get $worldH(){return worldH}",
    "get $lives(){return lives}", "get $score(){return score}",
    "set $menuIndex(v){menuIndex=v}", "set $playerName(v){playerName=v}",
  ].join(",\n  ");
  js = js.replace(/\}\)\(\);\s*$/,
    `Object.defineProperties(globalThis, Object.getOwnPropertyDescriptors({\n  ${exported}\n}));\n})();`);

  const noop = () => {};
  const ctxStub = new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop),
                                  set: (t, k, v) => { t[k] = v; return true; } });
  const canvasStub = { width: 800, height: 500, style: {}, getContext: () => ctxStub };
  const elStub = () => ({ classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
                          style: {}, hidden: false, addEventListener: noop, dataset: {},
                          offsetWidth: 0, muted: false, currentTime: 0,
                          play: () => ({ then: (f) => { f && f(); return { catch: noop }; },
                                         catch: noop }),
                          pause: noop });

  const sandbox = {
    console,
    WebSocket,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout,
    performance: { now: () => Date.now() },
    requestAnimationFrame: noop,
    atob: s => Buffer.from(s, "base64").toString("binary"),
    // ?server= points the client at the live server; ?room= puts both in one room
    location: { protocol: "http:", host: "localhost:4000",
                search: `?server=${encodeURIComponent(SERVER)}&room=${ROOM}` },
    URLSearchParams,
    Math, JSON, Object, Array, String, Number, Boolean, Map, Set, Date, Error,
    Uint8Array, ArrayBuffer, isNaN, isFinite, parseInt, parseFloat, encodeURIComponent,
    document: {
      getElementById: id => (id === "game" ? canvasStub : elStub()),
      querySelectorAll: () => [],
      addEventListener: noop,
      documentElement: { classList: { toggle: noop } },
      hidden: false,
    },
    window: {
      addEventListener: noop,
      matchMedia: () => ({ matches: false, addEventListener: noop }),
      devicePixelRatio: 1, innerWidth: 900, innerHeight: 700,
      requestAnimationFrame: noop,
      AudioContext: function () {
        const p = () => ({ value: 0, setTargetAtTime: noop, setValueAtTime: noop,
                           exponentialRampToValueAtTime: noop });
        const node = () => ({ connect(n) { return n; }, disconnect: noop, start: noop,
                              stop: noop, frequency: p(), gain: p(), type: "", buffer: null,
                              loop: false, onended: null, Q: p() });
        return { state: "running", currentTime: 0, destination: {}, sampleRate: 44100,
                 resume: noop, suspend: noop, close: noop,
                 createOscillator: node, createGain: node, createBiquadFilter: node,
                 createBufferSource: node, createBuffer: () => ({ getChannelData: () => new Float32Array(8) }),
                 decodeAudioData: (b, ok) => ok && ok({ duration: 1 }) };
      },
    },
    navigator: { vibrate: noop, maxTouchPoints: 0, userAgent: "node" },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const vm = require("node:vm");
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: `client-${label}.js` });
  return sandbox;
}

// Drive a client the way its own game loop does, and that means all of it.
// netFrame() keeps a wrecked taxi reporting its position; updateRemotes() and
// updateCamera() decide where anything actually ends up on screen. Leaving the
// camera out once hid a bug where players were correctly received and still
// nowhere to be seen, because the view had scrolled away from them.
function step(c, n = 1) {
  for (let i = 0; i < n; i++) {
    c.input.up = c.input.left = c.input.right = false;
    c.handleInput();
    c.update();
    c.netFrame();
    c.updateRemotes();
    c.updateCamera();
  }
}

// Is that player actually within this client's viewport, not merely known to it
const onScreen = (c, id) => {
  const r = c.$remotes.get(id);
  if (!r || !r.seen) return false;
  const sx = r.x - c.$camera.x;
  const sy = r.y - c.$camera.y;
  return sx > -r.w && sx < 800 && sy > -r.h && sy < 500;
};

async function pump(clients, frames, perBatch = 30) {
  for (let done = 0; done < frames; done += perBatch) {
    for (const c of clients) step(c, Math.min(perBatch, frames - done));
    await wait(20);   // let the socket actually deliver
  }
}

// ── Go ──
const A = spawnClient("A");
const B = spawnClient("B");
A.$playerName = "ALPHA";
B.$playerName = "BRAVO";

for (const c of [A, B]) {
  c.bootGame();
  c.$menuIndex = 1;          // MULTIPLAYER
  c.input.action = true;
  c.handleInput();
}
check("both clients leave the menu for the lobby",
      A.$state === "lobby" && B.$state === "lobby", `(${A.$state}/${B.$state})`);

await wait(1500);
check("A reaches the server", A.$netState === "joined", `(${A.$netState} ${A.$netError})`);
check("B reaches the server", B.$netState === "joined", `(${B.$netState} ${B.$netError})`);

// Neither is playing yet: the room waits for a field and then counts down, so
// that whoever connected first is not already several fares up.
check("nobody is flying during the countdown",
      A.$state === "lobby" && B.$state === "lobby", `(${A.$state}/${B.$state})`);
check("and the room says why",
      ["waiting", "starting"].includes(A.$roomState.phase), `(${A.$roomState.phase})`);

const startBy = Date.now() + 20000;
while (Date.now() < startBy && A.$state !== "playing") await pump([A, B], 60);

check("both are playing", A.$state === "playing" && B.$state === "playing",
      `(${A.$state}/${B.$state})`);
check("and started together, neither ahead of the other",
      A.$score === 0 && B.$score === 0, `(${A.$score}/${B.$score})`);
check("they got different ids", A.$myPlayerId !== B.$myPlayerId,
      `(${A.$myPlayerId} / ${B.$myPlayerId})`);
check("each sees the other in the room",
      Object.keys(A.$roomState.players).length === 2, JSON.stringify(Object.keys(A.$roomState.players)));

// The world has to be the same one for both, or nothing lines up
check("both got the same world size",
      A.$roomState.world_w === B.$roomState.world_w &&
      A.$roomState.world_h === B.$roomState.world_h,
      `(${A.$roomState.world_w} vs ${B.$roomState.world_w})`);
// Not "the world grew": these are one-sector levels, every pad is in the first
// screen, and handing out empty sectors is what put players out of each other's
// sight in the first place. The grid follows the head count only as far as the
// map has content for it.
check("the world stays inside what the level holds",
      A.$roomState.world_w === 800 && A.$roomState.world_h === 500,
      `(${A.$roomState.world_w}x${A.$roomState.world_h})`);

// ── The fare board must agree ──
const fareIds = c => c.$passengers.map(p => p.fareId).sort().join(",");
check("both boards hold the same fares", fareIds(A) === fareIds(B),
      `(${fareIds(A)} vs ${fareIds(B)})`);
check("and the passengers stand in the same spot",
      A.$passengers.every((p, i) => Math.abs(p.x - B.$passengers[i].x) < 0.001),
      `(${A.$passengers.map(p => p.x)} vs ${B.$passengers.map(p => p.x)})`);

function parkBeside(c, p) {
  const pd = c.$pads[p.padIndex];
  const left = (p.x - c.PERSON_HALF_W) - pd.x;
  const right = (pd.x + pd.w) - (p.x + c.PERSON_HALF_W);
  const x = left > right ? p.x - c.PERSON_HALF_W - 4 - c.$taxi.w
                         : p.x + c.PERSON_HALF_W + 4;
  c.$taxi.x = Math.max(pd.x, Math.min(x, pd.x + pd.w - c.$taxi.w));
  c.$taxi.y = pd.y - c.$taxi.h - c.GEAR_LEN;
  c.$taxi.vx = 0; c.$taxi.vy = 0; c.$taxi.gear = 1;
  c.$taxi.landed = true; c.$taxi.landedPad = p.padIndex;
}

// ── One fare, two takers: exactly one wins ──
// Both park beside the same passenger. Parked rather than hovering: a taxi left
// to itself falls, crashes, and update() then stops running entirely.
const fare = A.$passengers[0];
parkBeside(A, fare);
parkBeside(B, B.$passengers.find(p => p.fareId === fare.fareId));
await pump([A, B], 240);

check("both are still flying, not wrecked",
      A.$state === "playing" && B.$state === "playing", `(${A.$state}/${B.$state})`);

// ── Positions have to cross ──
const otherId = c => Object.keys(c.$roomState.players).find(id => id !== c.$myPlayerId);
const bSeenByA = A.$remotes.get(otherId(A));
const aSeenByB = B.$remotes.get(otherId(B));
check("A can see B's taxi", bSeenByA && bSeenByA.seen, JSON.stringify([...A.$remotes.keys()]));
check("and where it really is",
      bSeenByA && Math.abs(bSeenByA.tx - B.$taxi.x) < 2,
      `(${bSeenByA && bSeenByA.tx} vs ${B.$taxi.x})`);
check("B can see A's taxi", aSeenByB && aSeenByB.seen, JSON.stringify([...B.$remotes.keys()]));
check("and where it really is",
      aSeenByB && Math.abs(aSeenByB.tx - A.$taxi.x) < 2,
      `(${aSeenByB && aSeenByB.tx} vs ${A.$taxi.x})`);

const aGot = A.$taxi.hasPassenger;
const bGot = B.$taxi.hasPassenger;
check("exactly one client got the fare", aGot !== bGot, `(A=${aGot}, B=${bGot})`);

const winner = aGot ? A : B;
const loser  = aGot ? B : A;
check("the loser's board no longer offers it",
      !loser.$passengers.some(p => p.fareId === fare.fareId && p.phase !== "aboard"),
      JSON.stringify(loser.$passengers.map(p => [p.fareId, p.phase])));
check("the winner was scored for the pickup by the server",
      winner.$score >= 10, `(${winner.$score})`);
check("the loser was not", loser.$score === 0, `(${loser.$score})`);

// ── Delivering scores on the server, and both see it ──
const dest = winner.$passengers.find(p => p.phase === "aboard").destPadIndex;
const destPad = winner.$pads[dest];
winner.$taxi.x = destPad.x + destPad.w/2 - winner.$taxi.w/2;
winner.$taxi.y = destPad.y - winner.$taxi.h - winner.GEAR_LEN;
winner.$taxi.vx = 0; winner.$taxi.vy = 0; winner.$taxi.gear = 1;
winner.$taxi.landed = true; winner.$taxi.landedPad = dest;
await pump([A, B], 240);

check("delivering scored on the server", winner.$score >= 60, `(${winner.$score})`);
const wid = winner.$myPlayerId;
check("and the other client sees that score too",
      loser.$roomState.players[wid] && loser.$roomState.players[wid].score >= 60,
      `(${loser.$roomState.players[wid] && loser.$roomState.players[wid].score})`);
check("a replacement fare arrived", Object.keys(winner.$roomState.fares).length >= 1,
      JSON.stringify(Object.keys(winner.$roomState.fares)));

// ── A crash costs a life, and the server is the one counting ──
check("the loser is still flying before we wreck it",
      loser.$state === "playing", `(${loser.$state}, ${loser.$lives} lives)`);

const livesBefore = loser.$lives;
loser.$taxi.landed = false;
loser.$taxi.y = 40;
loser.$taxi.vy = 9;                  // straight into the ground
await pump([A, B], 300);
check("a crash costs exactly one life", loser.$lives === livesBefore - 1,
      `(${livesBefore} -> ${loser.$lives}, state ${loser.$state})`);
check("and the other client is told", winner.$roomState.players[loser.$myPlayerId].lives === livesBefore - 1,
      `(${winner.$roomState.players[loser.$myPlayerId].lives})`);

// ── No passenger may appear under a parked taxi ──
// One did, and it blew the taxi up. Both clients are parked on pads here, so
// every fare the room mints while they sit there has to go elsewhere.
{
  // The hazard is local: a passenger standing under *my* taxi, which my own
  // crush check would kill me for. Checked per client and per frame rather than
  // against a snapshot of who was parked where, because the taxis move.
  const offending = new Set();
  const scan = () => {
    for (const c of [A, B]) {
      if (!c.$taxi.landed) continue;
      for (const p of c.$passengers) {
        if (p.phase !== "waiting") continue;
        if (p.padIndex !== c.$taxi.landedPad) continue;
        // Sharing a pad is the normal case — you are meant to land beside them.
        // Only an actual overlap is the hazard, and a fare placed under an
        // already-parked taxi is flagged and cannot hurt it.
        const overlaps = p.x + c.PERSON_HALF_W > c.$taxi.x &&
                         p.x - c.PERSON_HALF_W < c.$taxi.x + c.$taxi.w;
        if (overlaps && !p.spawnedUnderTaxi) {
          offending.add(`${p.fareId}@pad${p.padIndex}`);
        }
      }
    }
  };

  let parked = 0;
  for (let round = 0; round < 12; round++) {
    const carrier = [A, B].find(c => !c.$taxi.hasPassenger &&
                                     c.$passengers.some(p => p.phase === "waiting"));
    if (!carrier) break;
    const fare = carrier.$passengers.find(p => p.phase === "waiting");
    parkBeside(carrier, fare);
    parked++;
    for (let i = 0; i < 7; i++) { await pump([A, B], 30); scan(); }
  }

  check("taxis were parked on pads during this", parked > 0, `(${parked} landings)`);
  check("no unflagged passenger ever stood under a parked taxi",
        offending.size === 0, JSON.stringify([...offending]));
  check("and nobody was wrecked by one",
        A.$state !== "crashed" || B.$state !== "crashed",
        `(${A.$state}/${B.$state})`);
}

// ── A wrecked player must still be findable by someone joining afterwards ──
// This is the "four players listed, three taxis on screen" report: a wrecked
// taxi stops simulating, so it used to stop reporting where it was, and anyone
// arriving later never heard a position for it at all.
const C = spawnClient("C");
C.$playerName = "CHARLIE";
C.bootGame();
C.$menuIndex = 1;
C.input.action = true;
C.handleInput();
await wait(1500);

check("a third client joins", C.$netState === "joined", `(${C.$netState} ${C.$netError})`);
check("and is told about all three players",
      Object.keys(C.$roomState.players).length === 3,
      JSON.stringify(Object.values(C.$roomState.players).map(p => p.name)));

await pump([A, B, C], 200);

// A third player grows the room, and everyone has to grow with it. Otherwise
// the ones who joined earlier stay penned in a corner of the map the newcomer
// is flying, and each keeps leaving the others' screens.
const worlds = [A, B, C].map(c => `${c.$worldW}x${c.$worldH}`);
check("all three agree on the size of the world",
      new Set(worlds).size === 1, JSON.stringify(worlds));
check("and it is the one the room reports",
      A.$worldW === A.$roomState.world_w && A.$worldH === A.$roomState.world_h,
      `(${A.$worldW}x${A.$worldH} vs ${A.$roomState.world_w}x${A.$roomState.world_h})`);

const wreckId = loser.$myPlayerId;
const wreckSeen = C.$remotes.get(wreckId);
check("the wrecked taxi is still on the newcomer's map",
      wreckSeen && wreckSeen.seen, JSON.stringify([...C.$remotes.entries()].map(([id, r]) => [id, r.seen])));
check("and in the place its owner left it",
      wreckSeen && Math.abs(wreckSeen.tx - loser.$taxi.x) < 2,
      `(${wreckSeen && wreckSeen.tx} vs ${loser.$taxi.x})`);

// Everyone listed has a taxi to go with them, and it is where the newcomer can
// see it. "Received" is not the same as "on screen": with a world bigger than
// its content, players ended up correctly known and still nowhere in view.
const listed = Object.keys(C.$roomState.players).filter(id => id !== C.$myPlayerId);
const seen = listed.filter(id => { const r = C.$remotes.get(id); return r && r.seen; });
check("every other player listed has been located",
      listed.length === seen.length, `(${listed.length} listed, ${seen.length} located)`);
check("and is actually within view",
      listed.every(id => onScreen(C, id)),
      JSON.stringify(listed.map(id => {
        const r = C.$remotes.get(id);
        return [id.slice(0, 4), r && `${(r.x - C.$camera.x).toFixed(0)},${(r.y - C.$camera.y).toFixed(0)}`];
      })));

C.netDisconnect();
await wait(400);

// ── One player finishing ends the round for everybody, then the next level ──
// Driven by delivering fares until the target score falls, so the finish is a
// real one rather than a state pushed in from the side.
{
  // C left the room a few checks ago, so only these two are still in it.
  const all = [A, B];
  const before = A.$roomState.level;

  // Ending it by everyone running out of lives rather than by grinding out the
  // target score: it is the same round-over transition and far cheaper to
  // reach. The winning path is covered by the room's own suite.
  const deadline0 = Date.now() + 40000;
  while (Date.now() < deadline0 &&
         !all.every(c => c.$state === "intermission")) {
    for (const c of all) {
      if (c.$state === "crashed") { c.input.action = true; c.handleInput(); }
      if (c.$state === "playing") {
        c.$taxi.landed = false; c.$taxi.landedPad = -1;
        c.$taxi.y = 30; c.$taxi.vy = 9;      // straight into the ground
      }
    }
    await pump(all, 90);
  }

  check("the round ends when nobody has lives left",
        all.every(c => c.$state === "intermission"),
        JSON.stringify(all.map(c => [c.$state, c.$lives])));
  check("every client is on the same screen at the same time",
        new Set(all.map(c => c.$state)).size === 1,
        JSON.stringify(all.map(c => c.$state)));
  check("nobody is left on a game-over screen",
        !all.some(c => c.$state === "gameOver"),
        JSON.stringify(all.map(c => c.$state)));

  // Nobody presses anything from here on
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && A.$roomState.level === before) {
    await pump(all, 60);
  }

  check("the room moves on to the next level by itself",
        A.$roomState.level !== before, `(still on ${A.$roomState.level})`);
  check("and every client follows it there",
        all.every(c => c.$state === "playing"),
        JSON.stringify(all.map(c => c.$state)));
  check("all on the same level",
        new Set(all.map(c => c.$roomState && c.$roomState.level)).size === 1,
        JSON.stringify(all.map(c => c.$roomState && c.$roomState.level)));
  check("with scores back to zero",
        all.every(c => c.$score === 0),
        JSON.stringify(all.map(c => c.$score)));
  check("and everyone flying again, including whoever was out",
        all.every(c => c.$lives === 3),
        JSON.stringify(all.map(c => c.$lives)));
}

// ── Leaving ──
A.netDisconnect();
await pump([B], 120);
check("B is told when A leaves",
      Object.keys(B.$roomState.players).length === 1,
      JSON.stringify(Object.keys(B.$roomState.players)));
B.netDisconnect();

const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILING` : "\nALL ONLINE CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
