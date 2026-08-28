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

  describe "fares never appear under a parked taxi" do
    test "a pad with someone standing on it is not used", %{room: room} do
      {:ok, _} = join(room, "a")
      pad_count = length(SpaceTaxi.Levels.pads(0))

      # Park on every pad but one, then keep taking fares so plenty are minted
      for {id, pad} <- Enum.zip(~w(a b c), 0..(pad_count - 2)) do
        join(room, id)
        :ok = Room.set_pad(room, id, pad)
      end

      free = pad_count - 1

      for _ <- 1..20 do
        [{fare_id, _} | _] = Enum.take(Room.snapshot(room).fares, 1)
        {:ok, _} = Room.claim_fare(room, "a", fare_id)
        fare = Room.snapshot(room).fares[fare_id]
        {:ok, _} = Room.deliver_fare(room, "a", fare_id, fare.to)
      end

      for {_id, f} <- Room.snapshot(room).fares do
        assert f.from == free,
               "a fare was put on pad #{f.from}, where a taxi is parked"
      end
    end

    test "taking off frees the pad again", %{room: room} do
      {:ok, _} = join(room, "a")
      :ok = Room.set_pad(room, "a", 0)
      :ok = Room.set_pad(room, "a", -1)

      # With nothing parked anywhere, every pad is fair game again
      seen =
        for _ <- 1..40, reduce: MapSet.new() do
          acc ->
            [{fare_id, _} | _] = Enum.take(Room.snapshot(room).fares, 1)
            from = Room.snapshot(room).fares[fare_id].from
            {:ok, _} = Room.claim_fare(room, "a", fare_id)
            fare = Room.snapshot(room).fares[fare_id]
            {:ok, _} = Room.deliver_fare(room, "a", fare_id, fare.to)
            MapSet.put(acc, from)
        end

      assert MapSet.size(seen) > 1
    end

    test "leaving frees the pad the player was on", %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, _} = join(room, "b")
      :ok = Room.set_pad(room, "b", 0)
      :ok = Room.leave(room, "b")

      seen =
        for _ <- 1..40, reduce: MapSet.new() do
          acc ->
            [{fare_id, _} | _] = Enum.take(Room.snapshot(room).fares, 1)
            from = Room.snapshot(room).fares[fare_id].from
            {:ok, _} = Room.claim_fare(room, "a", fare_id)
            fare = Room.snapshot(room).fares[fare_id]
            {:ok, _} = Room.deliver_fare(room, "a", fare_id, fare.to)
            MapSet.put(acc, from)
        end

      assert 0 in seen, "pad 0 stayed blocked by a player who is gone"
    end

    test "with every pad taken, no fare is put out at all", %{room: room} do
      pads = length(SpaceTaxi.Levels.pads(0))
      ids = Enum.map(0..(pads - 1), &"p#{&1}")
      for id <- ids, do: join(room, id)
      for {id, pad} <- Enum.zip(ids, 0..(pads - 1)), do: Room.set_pad(room, id, pad)

      # Clear the board, then check nothing refills onto an occupied pad
      for {fare_id, _} <- Room.snapshot(room).fares do
        {:ok, _} = Room.claim_fare(room, hd(ids), fare_id)
        fare = Room.snapshot(room).fares[fare_id]
        {:ok, _} = Room.deliver_fare(room, hd(ids), fare_id, fare.to)
      end

      # An empty board beats one that drops a passenger under a taxi
      assert map_size(Room.snapshot(room).fares) == 0
    end

    test "an unknown pad index is ignored rather than trusted", %{room: room} do
      {:ok, _} = join(room, "a")
      assert :ok = Room.set_pad(room, "a", 99)
      assert :ok = Room.set_pad(room, "a", -7)
    end
  end

  describe "the fare board shrinks too" do
    test "a departure takes the surplus fare with it", %{room: room} do
      for id <- ~w(a b c d), do: join(room, id)
      assert map_size(Room.snapshot(room).fares) == 2

      :ok = Room.leave(room, "d")
      :ok = Room.leave(room, "c")
      :ok = Room.leave(room, "b")

      # One player wants one fare. Leaving two standing means two passengers on
      # the pads with nobody to collect them.
      assert map_size(Room.snapshot(room).fares) == 1
    end

    test "a fare someone is carrying is never taken away", %{room: room} do
      for id <- ~w(a b c d), do: join(room, id)
      [{fare_id, _} | _] = Enum.take(Room.snapshot(room).fares, 1)
      {:ok, _} = Room.claim_fare(room, "a", fare_id)

      :ok = Room.leave(room, "d")
      :ok = Room.leave(room, "c")
      :ok = Room.leave(room, "b")

      # Removing it would strand player a with a passenger the room denies
      assert Room.snapshot(room).fares[fare_id]
      assert Room.snapshot(room).fares[fare_id].claimed_by == "a"
    end

    test "the board never drops below one", %{room: room} do
      {:ok, _} = join(room, "a")
      assert map_size(Room.snapshot(room).fares) == 1
    end
  end

  describe "leaving" do
    test "removes the player", %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, _} = join(room, "b")
      :ok = Room.leave(room, "a")
      assert Map.keys(Room.snapshot(room).players) == ["b"]
    end

    test "the last one out closes the room", %{room: room} do
      {:ok, _} = join(room, "a")
      ref = Process.monitor(room)
      assert :empty = Room.leave(room, "a")
      # Otherwise the next session inherits this one's fares and scores
      assert_receive {:DOWN, ^ref, :process, ^room, :normal}, 1_000
    end

    test "a room with players left in it stays up", %{room: room} do
      {:ok, _} = join(room, "a")
      {:ok, _} = join(room, "b")
      assert :ok = Room.leave(room, "a")
      assert Process.alive?(room)
    end

    test "releases whatever fare they were carrying", %{room: room} do
      {:ok, _} = join(room, "a")
      # A second player, or the room closes with a and there is nothing left to
      # inspect. The passenger has to go back on the board, not out of it.
      {:ok, _} = join(room, "b")
      [{fare_id, _} | _] = Enum.take(Room.snapshot(room).fares, 1)
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
