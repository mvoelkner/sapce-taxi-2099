defmodule SpaceTaxiWeb.UserSocket do
  @moduledoc """
  The socket every player connects through.

  There is no authentication: the game is played among friends and the trust
  model says so explicitly. A player id is handed out here rather than accepted
  from the client, so two players cannot collide on one id by accident.
  """

  use Phoenix.Socket

  channel "room:*", SpaceTaxiWeb.RoomChannel

  @impl true
  def connect(params, socket, _connect_info) do
    name =
      params
      |> Map.get("name", "PILOT")
      |> to_string()
      |> String.slice(0, 12)

    {:ok, assign(socket, player_id: generate_id(), name: name)}
  end

  # Nil, so a socket is not addressable from outside. Nothing broadcasts to a
  # single player: everything a client needs arrives over its room channel.
  @impl true
  def id(_socket), do: nil

  defp generate_id, do: 8 |> :crypto.strong_rand_bytes() |> Base.url_encode64(padding: false)
end
