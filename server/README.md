# Space Taxi — multiplayer server

Elixir/Phoenix. Holds fares, lives, scores and round state for a room. It runs
**no physics**: each client simulates its own taxi locally so the controls stay
as direct as they are in single player, and foreign positions are relayed
without being checked.

Design and reasoning: `docs/superpowers/specs/2026-08-14-multiplayer-architecture-design.md`
(kept locally, not in the repository).

## Running it

No Elixir installation needed — everything goes through the container:

```sh
scripts/mix.sh deps.get      # first time only
scripts/mix.sh phx.server    # http://localhost:4000
MIX_ENV=test scripts/mix.sh test
```

Two checks against a running server:

```sh
node test/wire.mjs      # two hand-rolled WebSocket clients, protocol only
node test/online.mjs    # two copies of the real game, played against each other
```

`wire.mjs` proves the server alone. `online.mjs` loads `index.html` twice in
separate sandboxes and plays a fare from one client to the other — the only
check that would catch the client and the server disagreeing about a field.

## Level data

`priv/levels.json` is **generated**, never edited:

```sh
node scripts/extract-levels.js          # regenerate
node scripts/extract-levels.js --check  # fail if stale
```

The client's `index.html` stays the single source of truth for pad positions;
the JavaScript harness fails if the committed copy has drifted. The game has to
keep working from a plain `file://` double-click, which rules out both sides
fetching one file at runtime.

## Protocol

Connect to `/socket/websocket`, then join `room:<name>` (`[a-zA-Z0-9_-]{1,32}`).
The join reply carries `player_id`, the level `schema` and the full state.

| Client sends | Meaning | Reply |
|---|---|---|
| `pos` | own taxi position, ~15 Hz | none — relayed to the others |
| `claim` `{fare}` | picking a fare up | `ok` / `error taken` |
| `deliver` `{fare, pad}` | dropping one off | `ok` / `error wrong_pad`, `not_yours` |
| `collide` `{with}` | hit another taxi | `ok`, possibly `ignored: debounced` |
| `crashed` | wrecked on its own | `ok`, possibly `ignored: invulnerable` |

The server broadcasts `state` (one snapshot per room per change) and relays
`pos`. Duplicate collision reports and crashes inside the invulnerability window
come back as `ok` with an `ignored` note, not as errors — both clients see the
same bump and both report it, which is expected rather than a fault.

## Deployment

`Dockerfile` builds a release into a runtime image without a compiler (~60 MB).
PandaStack detects it and runs it as a container.

Environment:

| Variable | Meaning |
|---|---|
| `SECRET_KEY_BASE` | required; `mix phx.gen.secret` |
| `PHX_HOST` | public hostname |
| `PORT` | defaults to 4000 |
| `ALLOWED_ORIGINS` | comma-separated; unset means same-origin, `*` disables the check |

Phoenix Channels' heartbeat is not optional here: an ingress in front of the
container cuts idle WebSockets after about 60 seconds, and a lobby sends nothing
on its own. On the client it is driven from the frame loop rather than the
simulation step — `update()` returns immediately unless the state is `playing`,
so a heartbeat living there stops the moment a player is wrecked or waiting.

## Connecting a client

`index.html` reads two query parameters:

| Parameter | Meaning |
|---|---|
| `?server=` | full WebSocket URL; defaults to the page's own host, or `ws://localhost:4000/socket/websocket` under `file://` |
| `?room=` | room name, `[a-zA-Z0-9_-]{1,32}`; defaults to `lobby` |
