// Two real WebSocket clients against the running server, speaking the Phoenix
// channel wire protocol by hand — no client library involved, so this proves
// the server end works on its own.
const URL = "ws://localhost:4000/socket/websocket?vsn=2.0.0&name=TEST";

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    let ref = 0;
    ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
    ws.onerror = (e) => reject(new Error(label + ": " + e.message));
    ws.onopen = () =>
      resolve({
        label,
        ws,
        inbox,
        send: (topic, event, payload) => {
          ref++;
          ws.send(JSON.stringify([String(ref), String(ref), topic, event, payload]));
          return String(ref);
        },
      });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function find(client, event, timeoutHint = "") {
  const hit = client.inbox.find((m) => m[3] === event);
  if (!hit) throw new Error(`${client.label}: no "${event}" received ${timeoutHint}\n  got: ${JSON.stringify(client.inbox.map(m => m[3]))}`);
  return hit;
}

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name} ${cond ? "" : detail}`);
};

const a = await connect("A");
const b = await connect("B");

const TOPIC = "room:wstest";
a.send(TOPIC, "phx_join", {});
await wait(400);
b.send(TOPIC, "phx_join", {});
await wait(400);

const joinA = find(a, "phx_reply");
const joinB = find(b, "phx_reply");
check("A joins the room", joinA[4].status === "ok", JSON.stringify(joinA[4]));
check("B joins the room", joinB[4].status === "ok", JSON.stringify(joinB[4]));

const idA = joinA[4].response.player_id;
const idB = joinB[4].response.player_id;
check("each player gets its own id", idA && idB && idA !== idB, `${idA} / ${idB}`);
check("the join carries pad geometry",
  joinA[4].response.state.pads.length >= 3,
  JSON.stringify(joinA[4].response.state.pads));
check("B sees both players on join",
  Object.keys(joinB[4].response.state.players).length === 2,
  JSON.stringify(Object.keys(joinB[4].response.state.players)));

// ── Position relay ──
b.inbox.length = 0;
a.inbox.length = 0;
a.send(TOPIC, "pos", { x: 123, y: 456, vx: 1 });
await wait(300);
const pos = b.inbox.find((m) => m[3] === "pos");
check("a position reaches the other player", pos && pos[4].x === 123, JSON.stringify(pos));
check("and does not come back to the sender",
  !a.inbox.some((m) => m[3] === "pos"),
  JSON.stringify(a.inbox.map(m => m[3])));

// ── Claiming a fare, first come first served ──
const fareId = Object.keys(joinA[4].response.state.fares)[0];
a.inbox.length = 0; b.inbox.length = 0;
const refA = a.send(TOPIC, "claim", { fare: fareId });
await wait(300);
const claimA = a.inbox.find((m) => m[1] === refA && m[3] === "phx_reply");
check("the first claim is accepted", claimA && claimA[4].status === "ok", JSON.stringify(claimA));

const refB = b.send(TOPIC, "claim", { fare: fareId });
await wait(300);
const claimB = b.inbox.find((m) => m[1] === refB && m[3] === "phx_reply");
check("the second claim is refused",
  claimB && claimB[4].status === "error" && claimB[4].response.reason === "taken",
  JSON.stringify(claimB));

const stateB = b.inbox.filter((m) => m[3] === "state").pop();
check("the claim is broadcast to everyone",
  stateB && stateB[4].fares[fareId].claimed_by === idA,
  JSON.stringify(stateB && stateB[4].fares[fareId]));

// ── Collision, both lose a life, the duplicate report is swallowed ──
a.inbox.length = 0; b.inbox.length = 0;
const refC = a.send(TOPIC, "collide", { with: idB });
await wait(300);
const colA = a.inbox.find((m) => m[1] === refC && m[3] === "phx_reply");
check("a collision is accepted", colA && colA[4].status === "ok", JSON.stringify(colA));

const afterCol = a.inbox.filter((m) => m[3] === "state").pop();
check("both players lose a life",
  afterCol && afterCol[4].players[idA].lives === 2 && afterCol[4].players[idB].lives === 2,
  JSON.stringify(afterCol && afterCol[4].players));

const refD = b.send(TOPIC, "collide", { with: idA });
await wait(300);
const colB = b.inbox.find((m) => m[1] === refD && m[3] === "phx_reply");
check("the duplicate report is swallowed, not counted",
  colB && colB[4].status === "ok" && colB[4].response.ignored === "debounced",
  JSON.stringify(colB));

// ── Heartbeat, the thing that keeps an ingress from cutting the socket ──
a.inbox.length = 0;
const refH = a.send("phoenix", "heartbeat", {});
await wait(300);
const hb = a.inbox.find((m) => m[1] === refH && m[3] === "phx_reply");
check("the server answers a heartbeat", hb && hb[4].status === "ok", JSON.stringify(hb));

// ── Leaving. Claim a fresh fare first, so the release is not something the
//    earlier collision had already done for us.
b.inbox.length = 0;
const freeFare = Object.keys(stateB[4].fares).find((f) => f !== fareId) ||
  Object.keys(afterCol[4].fares).find((f) => afterCol[4].fares[f].claimed_by === null);
a.send(TOPIC, "claim", { fare: freeFare });
await wait(300);
const heldState = b.inbox.filter((m) => m[3] === "state").pop();
check("A is holding a fare before leaving",
  heldState && heldState[4].fares[freeFare] &&
    heldState[4].fares[freeFare].claimed_by === idA,
  JSON.stringify(heldState && heldState[4].fares[freeFare]));

b.inbox.length = 0;
a.ws.close();
await wait(600);
const afterLeave = b.inbox.filter((m) => m[3] === "state").pop();
check("leaving broadcasts a new state at all",
  !!afterLeave, JSON.stringify(b.inbox.map((m) => m[3])));
check("leaving removes the player",
  afterLeave && !afterLeave[4].players[idA],
  JSON.stringify(afterLeave && Object.keys(afterLeave[4].players)));
check("and hands the fare back to the board",
  afterLeave && afterLeave[4].fares[freeFare] &&
    afterLeave[4].fares[freeFare].claimed_by === null,
  JSON.stringify(afterLeave && afterLeave[4].fares[freeFare]));

b.ws.close();

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILING` : "\nALL WIRE CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
