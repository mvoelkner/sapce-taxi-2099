defmodule SpaceTaxi.Room do
  @moduledoc """
  One game room, as a GenServer.

  Authority is deliberately split. This process owns what has to be the same for
  everyone — fares and who claimed them, lives, scores, round state. It does not
  own taxi positions and runs no physics: each client simulates its own taxi
  locally and without delay, which for a precision landing game matters more
  than anything else here. Foreign taxi positions are relayed, never verified.

  The trust model is a circle of friends. Someone determined to cheat can, and
  that was accepted knowingly. The checks below exist to keep honest clients
  consistent with each other, not to defend against a hostile one.
  """

  use GenServer

  alias SpaceTaxi.Levels

  # Both clients notice the same collision and both report it. Without a window
  # in which further reports for the same pair are dropped, one bump costs two
  # lives instead of one.
  @collision_window_ms 500

  # A moment of invulnerability after a hit. Without it a single network hiccup
  # turns one collision into a chain of counted hits while the taxis are still
  # inside each other.
  @invulnerable_ms 1_000

  @starting_lives 3
  @pickup_score 10
  @delivery_score 50
  @target_score 500

  # Density, not area, is what makes the world feel right: the sector grid grows
  # with the player count so that pads per player stays roughly constant.
  @grids [{1, {1, 1}}, {4, {2, 2}}, {7, {3, 2}}, {10, {3, 3}}]

  defmodule Player do
    @moduledoc false
    # invulnerable_until is nil, not 0: the clock behind it is monotonic time,
    # which starts out negative, so 0 would read as a moment in the future and
    # leave every player permanently invulnerable.
    defstruct [:id, :name, :invulnerable_until, lives: 3, score: 0, alive?: true]
  end

  defmodule Fare do
    @moduledoc false
    defstruct [:id, :from, :to, :claimed_by]
  end

  # ── Client API ────────────────────────────────────────────

  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def child_spec(opts) do
    %{
      id: Keyword.get(opts, :id, __MODULE__),
      start: {__MODULE__, :start_link, [opts]},
      restart: :temporary
    }
  end

  def join(room, player_id, name), do: GenServer.call(room, {:join, player_id, name})
  def leave(room, player_id), do: GenServer.call(room, {:leave, player_id})
  def snapshot(room), do: GenServer.call(room, :snapshot)
  def claim_fare(room, player_id, fare_id), do: GenServer.call(room, {:claim, player_id, fare_id})

  def deliver_fare(room, player_id, fare_id, pad_index),
    do: GenServer.call(room, {:deliver, player_id, fare_id, pad_index})

  @doc """
  Tell the room which pad a player is standing on, or -1 after taking off.

  The server holds no taxi positions — that is the client's business — but it
  does have to know which pads are occupied, or a fare gets put out underneath a
  parked taxi and kills it on the spot. Sent only when the pad changes, so this
  is a handful of messages a minute rather than part of the position stream.
  """
  def set_pad(room, player_id, pad_index),
    do: GenServer.call(room, {:set_pad, player_id, pad_index})

  def collide(room, a, b), do: GenServer.call(room, {:collide, a, b})
  def hit(room, player_id, reason), do: GenServer.call(room, {:hit, player_id, reason})
  def award(room, player_id, points), do: GenServer.call(room, {:award, player_id, points})

  def collision_window_ms, do: @collision_window_ms
  def invulnerable_ms, do: @invulnerable_ms
  def target_score, do: @target_score
  def starting_lives, do: @starting_lives

  # ── Server ────────────────────────────────────────────────

  @impl true
  def init(opts) do
    level = Keyword.get(opts, :level, 0)
    seed = Keyword.get(opts, :seed, :erlang.unique_integer([:positive]))

    {:ok,
     %{
       level: level,
       players: %{},
       fares: %{},
       phase: :running,
       winner: nil,
       recent_collisions: %{},
       # player id -> pad index they are parked on
       occupied: %{},
       rand: :rand.seed_s(:exsss, {seed, seed + 1, seed + 2}),
       next_fare: 0
     }}
  end

  @impl true
  def handle_call({:join, id, name}, _from, state) do
    player = Map.get(state.players, id) || %Player{id: id, name: name, lives: @starting_lives}

    state =
      state
      |> put_in([:players, id], player)
      |> refill_fares()

    {:reply, {:ok, public(state)}, state}
  end

  def handle_call({:leave, id}, _from, state) do
    state =
      state
      |> release_fares_of(id)
      |> update_in([:players], &Map.delete(&1, id))
      # Their taxi went with them, so the pad is free again
      |> update_in([:occupied], &Map.delete(&1, id))
      # Fewer players want fewer fares. Without this the pads keep every
      # passenger a busier room put out, and one player is left looking at a
      # crowd nobody is coming to collect.
      |> shed_fares()

    if state.players == %{} do
      # Nothing here is worth keeping once the room is empty, and keeping it
      # means the next session inherits these fares and scores. The registry
      # starts a fresh room on the next join.
      {:stop, :normal, :empty, state}
    else
      {:reply, :ok, state}
    end
  end

  def handle_call(:snapshot, _from, state), do: {:reply, public(state), state}

  def handle_call({:claim, player_id, fare_id}, _from, state) do
    with {:ok, player} <- fetch_player(state, player_id),
         :ok <- require_alive(player),
         :ok <- require_not_carrying(state, player_id),
         {:ok, fare} <- fetch_fare(state, fare_id),
         :ok <- require_unclaimed(fare) do
      state =
        state
        |> put_in([:fares, fare_id, Access.key!(:claimed_by)], player_id)
        |> add_score(player_id, @pickup_score)
        # A replacement appears as soon as one is picked up, not once it is
        # delivered: otherwise most players spend the round watching.
        |> refill_fares()

      {:reply, {:ok, public(state)}, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:deliver, player_id, fare_id, pad_index}, _from, state) do
    with {:ok, player} <- fetch_player(state, player_id),
         :ok <- require_alive(player),
         {:ok, fare} <- fetch_fare(state, fare_id),
         :ok <- require_owner(fare, player_id),
         :ok <- require_pad(fare, pad_index) do
      state =
        state
        |> update_in([:fares], &Map.delete(&1, fare_id))
        |> add_score(player_id, @delivery_score)
        |> refill_fares()
        |> check_round_end()

      {:reply, {:ok, public(state)}, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:set_pad, player_id, pad_index}, _from, state) do
    pad_count = length(Levels.pads(state.level))

    state =
      cond do
        not Map.has_key?(state.players, player_id) ->
          state

        # -1 means airborne; anything outside the level is a client talking
        # nonsense and is treated as airborne rather than trusted.
        is_integer(pad_index) and pad_index >= 0 and pad_index < pad_count ->
          put_in(state.occupied[player_id], pad_index)

        true ->
          update_in(state.occupied, &Map.delete(&1, player_id))
      end

    {:reply, :ok, state}
  end

  def handle_call({:collide, a, b}, _from, state) do
    with :ok <- require_distinct(a, b),
         {:ok, _} <- fetch_player(state, a),
         {:ok, _} <- fetch_player(state, b),
         :ok <- require_not_debounced(state, a, b) do
      now = now_ms()

      state =
        state
        |> put_in([:recent_collisions, pair_key(a, b)], now)
        |> penalise(a, now)
        |> penalise(b, now)
        |> check_round_end()

      {:reply, {:ok, public(state)}, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:hit, player_id, _reason}, _from, state) do
    with {:ok, player} <- fetch_player(state, player_id),
         :ok <- require_vulnerable(player) do
      state =
        state
        |> penalise(player_id, now_ms())
        |> check_round_end()

      {:reply, {:ok, public(state)}, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:award, player_id, points}, _from, state) do
    case fetch_player(state, player_id) do
      {:ok, _} ->
        state = state |> add_score(player_id, points) |> check_round_end()
        {:reply, {:ok, public(state)}, state}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  # ── Guards ────────────────────────────────────────────────

  defp fetch_player(state, id) do
    case Map.fetch(state.players, id) do
      {:ok, player} -> {:ok, player}
      :error -> {:error, :unknown_player}
    end
  end

  defp fetch_fare(state, id) do
    case Map.fetch(state.fares, id) do
      {:ok, fare} -> {:ok, fare}
      :error -> {:error, :unknown_fare}
    end
  end

  defp require_alive(%Player{alive?: true}), do: :ok
  defp require_alive(_), do: {:error, :not_alive}

  defp require_unclaimed(%Fare{claimed_by: nil}), do: :ok
  defp require_unclaimed(_), do: {:error, :taken}

  defp require_owner(%Fare{claimed_by: id}, id), do: :ok
  defp require_owner(_, _), do: {:error, :not_yours}

  defp require_pad(%Fare{to: to}, to), do: :ok
  defp require_pad(_, _), do: {:error, :wrong_pad}

  defp require_distinct(a, a), do: {:error, :same_player}
  defp require_distinct(_, _), do: :ok

  defp require_not_carrying(state, player_id) do
    if Enum.any?(state.fares, fn {_, f} -> f.claimed_by == player_id end),
      do: {:error, :already_carrying},
      else: :ok
  end

  defp require_vulnerable(%Player{invulnerable_until: nil}), do: :ok

  defp require_vulnerable(%Player{invulnerable_until: until}) do
    if now_ms() < until, do: {:error, :invulnerable}, else: :ok
  end

  defp require_not_debounced(state, a, b) do
    case Map.get(state.recent_collisions, pair_key(a, b)) do
      nil -> :ok
      at -> if now_ms() - at < @collision_window_ms, do: {:error, :debounced}, else: :ok
    end
  end

  # Order-free, so A-reports-B and B-reports-A collapse onto one entry
  defp pair_key(a, b), do: Enum.sort([a, b])

  # Monotonic, so debounce and invulnerability windows survive a clock change
  defp now_ms, do: System.monotonic_time(:millisecond)

  # ── State changes ─────────────────────────────────────────

  defp penalise(state, player_id, now) do
    update_in(state, [:players, player_id], fn player ->
      lives = max(0, player.lives - 1)

      %{
        player
        | lives: lives,
          alive?: lives > 0,
          invulnerable_until: now + @invulnerable_ms
      }
    end)
    |> release_fares_of(player_id)
  end

  defp add_score(state, player_id, points) do
    update_in(state, [:players, player_id, Access.key!(:score)], &(&1 + points))
  end

  # A wreck drops its passenger back onto the board rather than deleting them
  defp release_fares_of(state, player_id) do
    update_in(state, [:fares], fn fares ->
      Map.new(fares, fn
        {id, %Fare{claimed_by: ^player_id} = fare} -> {id, %{fare | claimed_by: nil}}
        other -> other
      end)
    end)
  end

  defp check_round_end(state) do
    cond do
      state.phase == :over ->
        state

      winner = Enum.find_value(state.players, fn {id, p} -> p.score >= @target_score && id end) ->
        %{state | phase: :over, winner: winner}

      state.players != %{} and Enum.all?(state.players, fn {_, p} -> not p.alive? end) ->
        %{state | phase: :over}

      true ->
        state
    end
  end

  # ── Fare board ────────────────────────────────────────────

  # Roughly half the players have a fare available at any time. Fewer and most
  # of the room loses every race; whoever comes second three times running stops
  # playing.
  defp wanted_fares(state) do
    max(1, div(map_size(state.players) + 1, 2))
  end

  defp refill_fares(state) do
    open = Enum.count(state.fares, fn {_, f} -> f.claimed_by == nil end)
    Enum.reduce(1..max(0, wanted_fares(state) - open)//1, state, fn _, acc -> add_fare(acc) end)
  end

  # The counterpart to refill_fares, for when the player count falls. Only
  # unclaimed fares go: taking one out of a taxi would strand its driver with a
  # passenger the room no longer admits to having.
  defp shed_fares(state) do
    wanted = wanted_fares(state)
    open = for {id, f} <- state.fares, f.claimed_by == nil, do: id

    # Newest first, so the ones players have been flying towards survive
    surplus =
      open
      |> Enum.sort_by(&fare_age/1, :desc)
      |> Enum.take(max(0, length(open) - wanted))

    update_in(state.fares, &Map.drop(&1, surplus))
  end

  # Fare ids are "f<n>" in the order they were created
  defp fare_age("f" <> n), do: String.to_integer(n)
  defp fare_age(_), do: 0

  defp add_fare(state) do
    pads = Levels.pads(state.level)
    # A passenger appearing under a parked taxi blows it up on the spot, so the
    # pads people are standing on are off limits. An empty board is the better
    # of the two outcomes when every pad is taken; the next take-off frees one.
    free = Enum.to_list(0..(length(pads) - 1)//1) -- Map.values(state.occupied)

    if length(pads) < 2 or free == [] do
      state
    else
      {pick, state} = random_index(state, length(free))
      from = Enum.at(free, pick)
      {offset, state} = random_index(state, length(pads) - 1)
      # Never deliver to the pickup pad: skipping over it keeps the draw uniform
      to = rem(from + 1 + offset, length(pads))

      id = "f#{state.next_fare}"
      fare = %Fare{id: id, from: from, to: to, claimed_by: nil}

      state
      |> put_in([:fares, id], fare)
      |> Map.put(:next_fare, state.next_fare + 1)
    end
  end

  defp random_index(state, bound) do
    {value, rand} = :rand.uniform_s(bound, state.rand)
    {value - 1, %{state | rand: rand}}
  end

  # ── Wire format ───────────────────────────────────────────

  defp public(state) do
    level = Levels.get(state.level) || %{cols: 1, rows: 1, world_w: 800, world_h: 500}

    {cols, rows} = grid_for(map_size(state.players))

    %{
      level: state.level,
      phase: state.phase,
      winner: state.winner,
      cols: cols,
      rows: rows,
      world_w: cols * elem(Levels.sector(), 0),
      world_h: rows * elem(Levels.sector(), 1),
      pads: level.pads,
      players: state.players,
      fares: state.fares
    }
  end

  defp grid_for(count) do
    Enum.find_value(@grids, {3, 3}, fn {upto, grid} -> count <= upto && grid end)
  end
end
