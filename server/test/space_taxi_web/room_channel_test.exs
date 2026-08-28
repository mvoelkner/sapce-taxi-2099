defmodule SpaceTaxiWeb.RoomChannelTest do
  use SpaceTaxiWeb.ChannelCase, async: false

  alias SpaceTaxi.{Room, RoomRegistry}
  alias SpaceTaxiWeb.UserSocket

  # A unique room per test, so the tests do not have to run in order
  setup context do
    room_name = "t#{:erlang.phash2(context.test)}"
    on_exit(fn -> stop_room(room_name) end)
    %{room_name: room_name}
  end

  defp stop_room(room_name) do
    case RoomRegistry.whereis(room_name) do
      nil -> :ok
      pid -> if Process.alive?(pid), do: GenServer.stop(pid, :normal), else: :ok
    end
  end

  defp connect_player(room_name, name \\ "PILOT") do
    {:ok, socket} = Phoenix.ChannelTest.connect(UserSocket, %{"name" => name})
    {:ok, reply, socket} = subscribe_and_join(socket, "room:" <> room_name, %{})
    {socket, reply}
  end

  # Every join broadcasts a state of its own. assert_broadcast takes the first
  # match in the mailbox, so without clearing those first a later assertion
  # would be checking the state as it was at join time.
  defp drain_state do
    receive do
      %Phoenix.Socket.Broadcast{event: "state"} -> drain_state()
    after
      50 -> :ok
    end
  end

  describe "joining" do
    test "hands out a player id and the current state", %{room_name: room} do
      {_socket, reply} = connect_player(room)

      assert is_binary(reply.player_id)
      assert reply.state.phase == :running
      assert map_size(reply.state.players) == 1
    end

    test "the level schema travels with the join", %{room_name: room} do
      {_socket, reply} = connect_player(room)
      assert reply.schema == SpaceTaxi.Levels.schema()
    end

    test "pad geometry is part of the state", %{room_name: room} do
      {_socket, reply} = connect_player(room)
      assert length(reply.state.pads) >= 3
      assert Enum.all?(reply.state.pads, &(&1.w > 0))
    end

    test "a bad room name is refused" do
      {:ok, socket} = Phoenix.ChannelTest.connect(UserSocket, %{})

      assert {:error, %{reason: "bad_room_name"}} =
               subscribe_and_join(socket, "room:has spaces", %{})
    end

    test "an existing player sees the newcomer", %{room_name: room} do
      {_first, _} = connect_player(room, "ONE")
      drain_state()
      {_second, _} = connect_player(room, "TWO")

      assert_broadcast "state", %{players: players}
      assert map_size(players) == 2
    end
  end

  describe "position relay" do
    test "reaches the others but not the sender", %{room_name: room} do
      {socket, reply} = connect_player(room)
      push(socket, "pos", %{"x" => 100, "y" => 200})

      assert_broadcast "pos", %{"x" => 100, "y" => 200, "id" => id}
      assert id == reply.player_id
      # broadcast_from!, so the sender's own socket never receives it back
      refute_push "pos", %{}
    end

    test "is not validated, because it is only ever advisory", %{room_name: room} do
      {socket, _} = connect_player(room)
      push(socket, "pos", %{"x" => "nonsense"})
      assert_broadcast "pos", %{"x" => "nonsense"}
    end
  end

  describe "claiming a fare" do
    test "succeeds once and is refused the second time", %{room_name: room} do
      {a, _} = connect_player(room, "A")
      {b, _} = connect_player(room, "B")

      fare_id = a_fare(room)
      drain_state()

      ref = push(a, "claim", %{"fare" => fare_id})
      assert_reply ref, :ok, %{}

      ref = push(b, "claim", %{"fare" => fare_id})
      assert_reply ref, :error, %{reason: "taken"}
    end

    test "broadcasts the new state to everyone", %{room_name: room} do
      {a, reply} = connect_player(room, "A")
      fare_id = a_fare(room)
      drain_state()

      ref = push(a, "claim", %{"fare" => fare_id})
      assert_reply ref, :ok, %{}

      assert_broadcast "state", %{fares: fares}
      assert fares[fare_id].claimed_by == reply.player_id
    end

    test "an unknown fare is refused", %{room_name: room} do
      {a, _} = connect_player(room)
      ref = push(a, "claim", %{"fare" => "nope"})
      assert_reply ref, :error, %{reason: "unknown_fare"}
    end
  end

  describe "collisions" do
    test "cost both players a life", %{room_name: room} do
      {a, reply_a} = connect_player(room, "A")
      {_b, reply_b} = connect_player(room, "B")

      drain_state()

      ref = push(a, "collide", %{"with" => reply_b.player_id})
      assert_reply ref, :ok, %{}

      assert_broadcast "state", %{players: players}
      assert players[reply_a.player_id].lives == 2
      assert players[reply_b.player_id].lives == 2
    end

    test "the duplicate report is answered quietly, not as an error", %{room_name: room} do
      {a, reply_a} = connect_player(room, "A")
      {b, reply_b} = connect_player(room, "B")

      ref = push(a, "collide", %{"with" => reply_b.player_id})
      assert_reply ref, :ok, %{}

      # B saw the same bump and reports it from its own side. That is the
      # expected case, not a fault, so it must not come back as an error.
      ref = push(b, "collide", %{"with" => reply_a.player_id})
      assert_reply ref, :ok, %{ignored: "debounced"}

      # And it must not have cost a second life
      assert SpaceTaxi.RoomRegistry.whereis(room)
             |> Room.snapshot()
             |> get_in([:players, reply_a.player_id, Access.key!(:lives)]) == 2
    end

    test "reporting a collision with yourself is refused", %{room_name: room} do
      {a, reply_a} = connect_player(room)
      ref = push(a, "collide", %{"with" => reply_a.player_id})
      assert_reply ref, :error, %{reason: "same_player"}
    end

    test "reporting a collision with an unknown player is refused", %{room_name: room} do
      {a, _} = connect_player(room)
      ref = push(a, "collide", %{"with" => "ghost"})
      assert_reply ref, :error, %{reason: "unknown_player"}
    end
  end

  describe "crashing" do
    test "costs a life", %{room_name: room} do
      {a, reply} = connect_player(room)

      drain_state()

      ref = push(a, "crashed", %{})
      assert_reply ref, :ok, %{}

      assert_broadcast "state", %{players: players}
      assert players[reply.player_id].lives == 2
    end

    test "a crash inside the invulnerability window is ignored, not rejected", %{room_name: room} do
      {a, _} = connect_player(room)

      ref = push(a, "crashed", %{})
      assert_reply ref, :ok, %{}

      ref = push(a, "crashed", %{})
      assert_reply ref, :ok, %{ignored: "invulnerable"}
    end
  end

  describe "leaving" do
    test "removes the player and tells the rest", %{room_name: room} do
      {a, reply_a} = connect_player(room, "A")
      {_b, _} = connect_player(room, "B")

      drain_state()

      # The test process is linked to the channel, and leaving shuts it down —
      # without unlinking, that exit would take the test with it.
      Process.unlink(a.channel_pid)
      leave(a)

      assert_broadcast "state", %{players: players}
      refute Map.has_key?(players, reply_a.player_id)
    end
  end

  defp a_fare(room_name) do
    RoomRegistry.whereis(room_name)
    |> Room.snapshot()
    |> Map.fetch!(:fares)
    |> Map.keys()
    |> hd()
  end
end
