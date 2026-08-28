defmodule SpaceTaxiWeb do
  @moduledoc """
  The entrypoint for defining your web interface, such
  as controllers, components, channels, and so on.

  This can be used in your application as:

      use SpaceTaxiWeb, :controller
      use SpaceTaxiWeb, :html

  The definitions below will be executed for every controller,
  component, etc, so keep them short and clean, focused
  on imports, uses and aliases.

  Do NOT define functions inside the quoted expressions
  below. Instead, define additional modules and import
  those modules here.
  """

  # The game itself is served from here too, so client and server share an
  # origin: netUrl() then derives the WebSocket address from the page it was
  # loaded from, and there is nothing to configure and no CORS to arrange.
  # scripts/serve-client.js copies the build in.
  def static_paths,
    do: ~w(assets fonts images favicon.ico robots.txt
           index.html manifest.webmanifest sw.js icons
           explosion3.png explosion.mp3)

  def router do
    quote do
      use Phoenix.Router, helpers: false

      # Import common connection and controller functions to use in pipelines
      import Plug.Conn
      import Phoenix.Controller
    end
  end

  def channel do
    quote do
      use Phoenix.Channel
    end
  end

  def controller do
    quote do
      use Phoenix.Controller,
        formats: [:html, :json],
        layouts: [html: SpaceTaxiWeb.Layouts]

      import Plug.Conn

      unquote(verified_routes())
    end
  end

  def verified_routes do
    quote do
      use Phoenix.VerifiedRoutes,
        endpoint: SpaceTaxiWeb.Endpoint,
        router: SpaceTaxiWeb.Router,
        statics: SpaceTaxiWeb.static_paths()
    end
  end

  @doc """
  When used, dispatch to the appropriate controller/live_view/etc.
  """
  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
