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
    "LEVELS", "GEAR_LEN", "PERSON_HALF_W", "input",
    "get $state(){return state}", "set $state(v){state=v}",
    "get $netState(){return netState}", "get $netError(){return netError}",
    "get $taxi(){return taxi}", "get $pads(){return pads}",
    "get $passengers(){return passengers}", "get $remotes(){return remotes}",
    "get $roomState(){return roomState}", "get $myPlayerId(){return myPlayerId}",
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

// Drive a client's simulation forward the way its own game loop would
function step(c, n = 1) {
  for (let i = 0; i < n; i++) {
    c.input.up = c.input.left = c.input.right = false;
    c.handleInput();
    c.update();
  }
}

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
check("both are playing", A.$state === "playing" && B.$state === "playing",
      `(${A.$state}/${B.$state})`);
check("they got different ids", A.$myPlayerId !== B.$myPlayerId,
      `(${A.$myPlayerId} / ${B.$myPlayerId})`);
check("each sees the other in the room",
      Object.keys(A.$roomState.players).length === 2, JSON.stringify(Object.keys(A.$roomState.players)));

// The world has to be the same one for both, or nothing lines up
check("both got the same world size",
      A.$roomState.world_w === B.$roomState.world_w &&
      A.$roomState.world_h === B.$roomState.world_h,
      `(${A.$roomState.world_w} vs ${B.$roomState.world_w})`);
check("the world grew for two players", A.$roomState.world_w > 800,
      `(${A.$roomState.world_w})`);

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
const livesBefore = loser.$lives;
loser.$taxi.landed = false;
loser.$taxi.y = 40;
loser.$taxi.vy = 9;                  // straight into the ground
await pump([A, B], 300);
check("a crash costs exactly one life", loser.$lives === livesBefore - 1,
      `(${livesBefore} -> ${loser.$lives})`);
check("and the other client is told", winner.$roomState.players[loser.$myPlayerId].lives === livesBefore - 1,
      `(${winner.$roomState.players[loser.$myPlayerId].lives})`);

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
