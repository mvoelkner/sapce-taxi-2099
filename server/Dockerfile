# Two stages: the release is built with the full toolchain and then copied into
# a runtime image that carries no compiler. PandaStack detects this file and
# runs the result as a container on Kubernetes.
# The official elixir image rather than hexpm/elixir: the latter ships without a
# CA bundle, and OTP 27 then refuses the TLS handshake to hex.pm outright. The
# runtime stage pins the same Alpine release so the release's NIFs still link.
ARG ELIXIR_VERSION=1.17-alpine
ARG ALPINE_VERSION=3.24

FROM elixir:${ELIXIR_VERSION} AS build

RUN apk add --no-cache build-base git ca-certificates

WORKDIR /app

RUN mix local.hex --force && mix local.rebar --force

ENV MIX_ENV=prod

# Dependencies first, in their own layer: they change far less often than the
# application, so a code edit does not re-fetch the world.
COPY mix.exs mix.lock ./
RUN mix deps.get --only prod && mix deps.compile

COPY config config
COPY priv priv
COPY lib lib

RUN mix compile
RUN mix release

# ── Runtime ────────────────────────────────────────────────
FROM alpine:${ALPINE_VERSION} AS app

RUN apk add --no-cache libstdc++ openssl ncurses-libs ca-certificates

WORKDIR /app

# Not root: nothing here needs it.
RUN adduser -D -h /app taxi
USER taxi

COPY --from=build --chown=taxi:taxi /app/_build/prod/rel/space_taxi ./

ENV HOME=/app
ENV PHX_SERVER=true
ENV PORT=4000

EXPOSE 4000

CMD ["bin/space_taxi", "start"]
