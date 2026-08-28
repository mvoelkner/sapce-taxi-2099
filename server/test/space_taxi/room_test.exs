defmodule SpaceTaxi.RoomTest do
  use ExUnit.Case, async: true

  alias SpaceTaxi.Room

  setup do
    {:ok, room} = start_supervised({Room, name: nil, level: 0, seed: 4242})
    %{room: room}
  end

  defp join(room, id), do: Room.join(room, id, "P#{id}")

  # Hits land only outside the invulnerability window, so knocking a player out
  # means waiting it out between them — the same thing a real client does.
  defp knock_out(room, id) do
    for _ <- 1..Room.starting_lives() do
      Room.hit(room, id, :crash)
      Process.sleep(Room.invulnerable_ms() + 5)
    end
  end

  describe "joining" do
    test "a player starts with three lives and no score", %{room: room} do
      {:ok, state} = join(room, "a")
      me = state.players["a"]
      assert me.lives == 3
      assert me.score == 0
      assert me.alive?
    end

    test "the room reports every player to every joiner", %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, state} = join(room, "b")
      assert Map.keys(state.players) |> Enum.sort() == ["a", "b"]
    end

    test "joining twice with the same id does not duplicate a player", %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, state} = join(room, "a")
      assert map_size(state.players) == 1
    end

    test "the world grows with the player count", %{room: room} do
      {:ok, one} = join(room, "a")
      assert {1, 1} == {one.cols, one.rows}

      {:ok, _} = join(room, "b")
      {:ok, four} = join(room, "c")
      assert {2, 2} == {four.cols, four.rows}
    end
  end

  describe "the fare board" do
    test "puts out roughly half the player count", %{room: room} do
      for id <- ~w(a b c d), do: join(room, id)
      state = Room.snapshot(room)
      assert map_size(state.fares) == 2
    end

    test "always offers at least one fare", %{room: room} do
      {:ok, _} = join(room, "a")
      assert map_size(Room.snapshot(room).fares) == 1
    end

    test "never routes a fare to its own pickup pad", %{room: room} do
      for id <- ~w(a b c d e f g h), do: join(room, id)

      for {_id, fare} <- Room.snapshot(room).fares do
        refute fare.from == fare.to
      end
    end
  end

  describe "claiming a fare" do
    setup %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, _} = join(room, "b")
      [{fare_id, fare}] = Enum.take(Room.snapshot(room).fares, 1)
      %{fare_id: fare_id, fare: fare}
    end

    test "the first claim wins", %{room: room, fare_id: fare_id} do
      assert {:ok, _} = Room.claim_fare(room, "a", fare_id)
      assert {:error, :taken} = Room.claim_fare(room, "b", fare_id)
    end

    test "a claim marks the fare as belonging to that player", %{room: room, fare_id: fare_id} do
      {:ok, _} = Room.claim_fare(room, "a", fare_id)
      assert Room.snapshot(room).fares[fare_id].claimed_by == "a"
    end

    test "an unknown fare is refused", %{room: room} do
      assert {:error, :unknown_fare} = Room.claim_fare(room, "a", "no-such-fare")
    end

    test "a player carrying a fare cannot claim a second", %{room: room, fare_id: fare_id} do
      {:ok, _} = Room.claim_fare(room, "a", fare_id)
      other = Room.snapshot(room).fares |> Map.keys() |> Enum.find(&(&1 != fare_id))

      if other do
        assert {:error, :already_carrying} = Room.claim_fare(room, "a", other)
      end
    end

    test "a dead player cannot claim", %{room: room, fare_id: fare_id} do
      knock_out(room, "a")
      assert {:error, :not_alive} = Room.claim_fare(room, "a", fare_id)
    end
  end

  describe "delivering a fare" do
    setup %{room: room} do
      {:ok, _} = join(room, "a")
      [{fare_id, fare}] = Enum.take(Room.snapshot(room).fares, 1)
      {:ok, _} = Room.claim_fare(room, "a", fare_id)
      %{fare_id: fare_id, fare: fare}
    end

    test "scores the player", %{room: room, fare_id: fare_id, fare: fare} do
      {:ok, _} = Room.deliver_fare(room, "a", fare_id, fare.to)
      assert Room.snapshot(room).players["a"].score > 0
    end

    test "delivering to the wrong pad is refused", %{room: room, fare_id: fare_id, fare: fare} do
      wrong = rem(fare.to + 1, 3)
      wrong = if wrong == fare.to, do: rem(wrong + 1, 3), else: wrong
      assert {:error, :wrong_pad} = Room.deliver_fare(room, "a", fare_id, wrong)
    end

    test "a fare someone else claimed cannot be delivered", %{
      room: room,
      fare_id: fare_id,
      fare: fare
    } do
      {:ok, _} = join(room, "b")
      assert {:error, :not_yours} = Room.deliver_fare(room, "b", fare_id, fare.to)
    end

    test "a replacement fare appears", %{room: room, fare_id: fare_id, fare: fare} do
      {:ok, _} = Room.deliver_fare(room, "a", fare_id, fare.to)
      fares = Room.snapshot(room).fares
      refute Map.has_key?(fares, fare_id)
      assert map_size(fares) == 1
    end
  end

  describe "collisions" do
    setup %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, _} = join(room, "b")
      :ok
    end

    test "cost both players a life", %{room: room} do
      {:ok, _} = Room.collide(room, "a", "b")
      state = Room.snapshot(room)
      assert state.players["a"].lives == 2
      assert state.players["b"].lives == 2
    end

    test "the second report of the same collision is dropped", %{room: room} do
      {:ok, _} = Room.collide(room, "a", "b")
      assert {:error, :debounced} = Room.collide(room, "b", "a")
      assert Room.snapshot(room).players["a"].lives == 2
    end

    test "the pair can collide again once the window has passed", %{room: room} do
      {:ok, _} = Room.collide(room, "a", "b")
      Process.sleep(Room.collision_window_ms() + 20)
      assert {:ok, _} = Room.collide(room, "a", "b")
      assert Room.snapshot(room).players["a"].lives == 1
    end

    test "a hit grants invulnerability, so a second one does not count", %{room: room} do
      {:ok, _} = Room.collide(room, "a", "b")
      assert {:error, :invulnerable} = Room.hit(room, "a", :crash)
      assert Room.snapshot(room).players["a"].lives == 2
    end

    test "colliding with yourself is refused", %{room: room} do
      assert {:error, :same_player} = Room.collide(room, "a", "a")
    end

    test "an unknown player is refused", %{room: room} do
      assert {:error, :unknown_player} = Room.collide(room, "a", "ghost")
    end

    test "a carried fare is released back to the board", %{room: room} do
      [{fare_id, _}] = Enum.take(Room.snapshot(room).fares, 1)
      {:ok, _} = Room.claim_fare(room, "a", fare_id)
      {:ok, _} = Room.collide(room, "a", "b")
      assert Room.snapshot(room).fares[fare_id].claimed_by == nil
    end
  end

  describe "the round" do
    test "runs while at least one player is alive", %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, _} = join(room, "b")

      knock_out(room, "a")

      state = Room.snapshot(room)
      refute state.players["a"].alive?
      assert state.phase == :running
    end

    test "ends once everyone is out of lives", %{room: room} do
      {:ok, _} = join(room, "a")

      knock_out(room, "a")

      assert Room.snapshot(room).phase == :over
    end

    test "ends when a player reaches the target score", %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, _} = join(room, "b")
      Room.award(room, "a", Room.target_score())
      state = Room.snapshot(room)
      assert state.phase == :over
      assert state.winner == "a"
    end

    test "a dead player keeps watching rather than being dropped", %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, _} = join(room, "b")

      knock_out(room, "a")

      assert Map.has_key?(Room.snapshot(room).players, "a")
    end
  end

  describe "leaving" do
    test "removes the player", %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, _} = join(room, "b")
      :ok = Room.leave(room, "a")
      assert Map.keys(Room.snapshot(room).players) == ["b"]
    end

    test "releases whatever fare they were carrying", %{room: room} do
      {:ok, _} = join(room, "a")
      [{fare_id, _}] = Enum.take(Room.snapshot(room).fares, 1)
      {:ok, _} = Room.claim_fare(room, "a", fare_id)
      :ok = Room.leave(room, "a")
      assert Room.snapshot(room).fares[fare_id].claimed_by == nil
    end
  end

  describe "level data" do
    test "is loaded from the client's own generated copy" do
      data = SpaceTaxi.Levels.all()
      assert length(data) == 5
      assert Enum.all?(data, &(length(&1.pads) >= 3))
    end

    test "pads carry real coordinates" do
      [first | _] = SpaceTaxi.Levels.all()
      assert Enum.all?(first.pads, &(&1.w > 0))
    end
  end
end
