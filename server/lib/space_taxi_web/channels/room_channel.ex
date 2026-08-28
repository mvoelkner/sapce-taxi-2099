defmodule SpaceTaxiWeb.RoomChannel do
  @moduledoc """
  One channel per game room.

  Position updates are relayed, never checked: each client owns its own taxi and
  simulates it locally, which is what keeps the controls as direct as they are
  in single player regardless of the connection. Everything that has to agree
  between players — fares, lives, scores, round state — goes through the room
  process instead and comes back as an authoritative reply.

  Positions arrive at roughly 15 Hz, not 60, and clients interpolate in between.
  At ten players that is around 150 small messages per second per room.
  """

  use Phoenix.Channel

  alias SpaceTaxi.{Levels, Room, RoomRegistry}

  @impl true
  def join("room:" <> room_name, _params, socket) do
    with :ok <- validate_name(room_name),
         {:ok, room} <- RoomRegistry.find_or_start(room_name),
         {:ok, state} <- Room.join(room, socket.assigns.player_id, socket.assigns.name) do
      socket = assign(socket, room: room, room_name: room_name)
      send(self(), :after_join)

      {:ok,
       %{
         player_id: socket.assigns.player_id,
         schema: Levels.schema(),
         state: wire(state)
       }, socket}
    else
      {:error, reason} -> {:error, %{reason: to_string(reason)}}
    end
  end

  @impl true
  def handle_info(:after_join, socket) do
    broadcast_state(socket)
    {:noreply, socket}
  end

  # ── Position relay ────────────────────────────────────────

  # No reply and no validation: this is the hot path, and a wrong position only
  # ever makes someone else's taxi look wrong on this one screen.
  @impl true
  def handle_in("pos", payload, socket) do
    broadcast_from!(socket, "pos", Map.put(payload, "id", socket.assigns.player_id))
    {:noreply, socket}
  end

  # ── Authoritative actions ─────────────────────────────────

  # Which pad this taxi is standing on, or -1 once it lifts off. Sent only when
  # it changes, so the room can keep fares off pads that are already taken
  # without holding positions.
  def handle_in("pad", %{"pad" => pad}, socket) when is_integer(pad) do
    Room.set_pad(socket.assigns.room, me(socket), pad)
    {:noreply, socket}
  end

  def handle_in("pad", _payload, socket), do: {:noreply, socket}

  def handle_in("claim", %{"fare" => fare_id}, socket) do
    reply_and_broadcast(socket, Room.claim_fare(socket.assigns.room, me(socket), fare_id))
  end

  def handle_in("deliver", %{"fare" => fare_id, "pad" => pad}, socket) do
    reply_and_broadcast(
      socket,
      Room.deliver_fare(socket.assigns.room, me(socket), fare_id, pad)
    )
  end

  def handle_in("collide", %{"with" => other_id}, socket) do
    # A debounced report is the expected case, not a fault: both clients see the
    # same bump and both report it. Answer quietly and broadcast nothing.
    case Room.collide(socket.assigns.room, me(socket), other_id) do
      {:ok, state} ->
        broadcast_state(socket, state)
        {:reply, {:ok, %{}}, socket}

      {:error, :debounced} ->
        {:reply, {:ok, %{ignored: "debounced"}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  def handle_in("crashed", _payload, socket) do
    case Room.hit(socket.assigns.room, me(socket), :crash) do
      {:ok, state} ->
        broadcast_state(socket, state)
        {:reply, {:ok, %{}}, socket}

      # Already counted by the collision that caused it
      {:error, :invulnerable} ->
        {:reply, {:ok, %{ignored: "invulnerable"}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  @impl true
  def terminate(_reason, socket) do
    case socket.assigns do
      %{room: room} ->
        # :empty means that was the last player and the room has stopped, so
        # there is neither anything to ask it nor anyone left to tell.
        case Room.leave(room, me(socket)) do
          :empty ->
            :ok

          :ok ->
            # broadcast!, not a raw PubSub message: only this path takes the
            # fastlane, and a hand-built Broadcast struct arrives at the other
            # players' channels as a handle_out call that does not exist there.
            broadcast!(socket, "state", wire(Room.snapshot(room)))
        end

      _ ->
        :ok
    end

    :ok
  end

  # ── Helpers ───────────────────────────────────────────────

  defp me(socket), do: socket.assigns.player_id

  defp reply_and_broadcast(socket, {:ok, state}) do
    broadcast_state(socket, state)
    {:reply, {:ok, %{}}, socket}
  end

  defp reply_and_broadcast(socket, {:error, reason}) do
    {:reply, {:error, %{reason: to_string(reason)}}, socket}
  end

  defp broadcast_state(socket, state \\ nil) do
    state = state || Room.snapshot(socket.assigns.room)
    broadcast!(socket, "state", wire(state))
  end

  # One snapshot per room per change, rather than a message per player: at ten
  # players the per-player alternative is an order of magnitude more traffic for
  # the same information.
  # One format for the whole system, defined next to the state it describes.
  defp wire(state), do: Room.wire(state)

  defp validate_name(name) do
    if name =~ ~r/^[a-zA-Z0-9_-]{1,32}$/, do: :ok, else: {:error, :bad_room_name}
  end
end
