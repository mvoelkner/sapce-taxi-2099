import Config

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :space_taxi, SpaceTaxiWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "0S2wOL10yDsaR4VoJTWWde3EHXJ4XVIOVg9u5vENooMSakIjaiCTsVko79S2AddI",
  server: false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# No waiting room in the suite: a round starts on the first join and starts at
# once. The tests that are actually about the wait ask for the real values.
config :space_taxi, :room, min_players: 1, countdown_ms: 0
