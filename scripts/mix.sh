#!/bin/sh
# Runs mix inside the Elixir container, so no Elixir has to be installed on the
# machine and the version matches what PandaStack will build.
#
#   scripts/mix.sh test
#   scripts/mix.sh phx.server
#
# deps/ and _build/ land in server/ and are gitignored, so a rebuild is only
# slow the first time. Hex and rebar live in a named volume for the same reason.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=elixir:1.17-alpine

exec docker run --rm -it \
  -v "$ROOT/server:/app" \
  -v space-taxi-hex:/root/.hex \
  -v space-taxi-mix:/root/.mix \
  -p 4000:4000 \
  -w /app \
  -e MIX_ENV="${MIX_ENV:-dev}" \
  "$IMAGE" \
  sh -c 'mix local.hex --force >/dev/null 2>&1;
         mix local.rebar --force >/dev/null 2>&1;
         exec mix "$@"' _ "$@"
