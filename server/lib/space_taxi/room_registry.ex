defmodule SpaceTaxi.RoomRegistry do
  @moduledoc """
  Finds or starts the `SpaceTaxi.Room` behind a room name.

  Rooms are temporary: when the last player leaves, the process ends and the
  next join under that name starts a fresh one. There is nothing to persist —
  a finished round has no value once everyone has left.
  """

  alias SpaceTaxi.Room

  @registry SpaceTaxi.Rooms
  @supervisor SpaceTaxi.RoomSupervisor

  def child_specs do
    [
      {Registry, keys: :unique, name: @registry},
      {DynamicSupervisor, name: @supervisor, strategy: :one_for_one}
    ]
  end

  @doc "The room process for this name, starting it if it is not running yet."
  def find_or_start(room_name, opts \\ []) do
    case Registry.lookup(@registry, room_name) do
      [{pid, _}] ->
        {:ok, pid}

      [] ->
        opts = Keyword.merge([name: via(room_name), level: 0], opts)

        case DynamicSupervisor.start_child(@supervisor, {Room, opts}) do
          {:ok, pid} -> {:ok, pid}
          # Someone else won the race between lookup and start
          {:error, {:already_started, pid}} -> {:ok, pid}
          other -> other
        end
    end
  end

  def whereis(room_name) do
    case Registry.lookup(@registry, room_name) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end

  defp via(room_name), do: {:via, Registry, {@registry, room_name}}
end
