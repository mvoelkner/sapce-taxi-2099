defmodule SpaceTaxiWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :space_taxi

  # The session will be stored in the cookie and signed,
  # this means its contents can be read but not tampered with.
  # Set :encryption_salt if you would also like to encrypt it.
  @session_options [
    store: :cookie,
    key: "_space_taxi_key",
    signing_salt: "2KT3wNMj",
    same_site: "Lax"
  ]

  # check_origin is configured per environment. Phoenix Channels bring their own
  # heartbeat, which is not optional here: an ingress in front of the container
  # cuts idle WebSockets after about 60 seconds, and a lobby sends nothing.
  socket "/socket", SpaceTaxiWeb.UserSocket,
    websocket: [timeout: 45_000],
    longpoll: false

  # Serve at "/" the static files from "priv/static" directory.
  #
  # You should set gzip to true if you are running phx.digest
  # when deploying your static files in production.
  # Plug.Static does not treat index.html as a directory index, so "/" would be
  # a 404 while "/index.html" worked. Rewriting the path is less surprising than
  # asking every player to type the filename.
  plug :serve_index_at_root

  plug Plug.Static,
    at: "/",
    from: :space_taxi,
    gzip: false,
    only: SpaceTaxiWeb.static_paths(),
    # Plug.Static's default is a bare "public", which has no max-age and no
    # Last-Modified to work from — so browsers fall back to heuristic caching
    # and serve the page from disk without asking. A player who loaded the game
    # before a fix then keeps playing the broken version, which is exactly what
    # happened. must-revalidate makes them ask every time; the etag keeps the
    # answer a 304 and the cost near zero.
    cache_control_for_etags: "public, max-age=0, must-revalidate"

  # Code reloading can be explicitly enabled under the
  # :code_reloader configuration of your endpoint.
  if code_reloading? do
    plug Phoenix.CodeReloader
  end

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options
  plug SpaceTaxiWeb.Router

  defp serve_index_at_root(%Plug.Conn{path_info: []} = conn, _opts),
    do: %{conn | path_info: ["index.html"]}

  defp serve_index_at_root(conn, _opts), do: conn
end
