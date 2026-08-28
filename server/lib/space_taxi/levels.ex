defmodule SpaceTaxi.Levels do
  @moduledoc """
  The level data, read from `priv/levels.json`.

  That file is generated out of the client's `index.html` by
  `scripts/extract-levels.js` — the client stays the single source of truth for
  pad positions, and the JavaScript harness fails if the committed copy has
  drifted. Nothing here is ever edited by hand.

  The file is read at compile time and baked into the module. The data changes
  only when the client does, which means a rebuild anyway, and this way a
  missing or malformed file breaks the build rather than the first request.
  """

  @levels_path Path.join(:code.priv_dir(:space_taxi) |> to_string(), "levels.json")
  @external_resource @levels_path

  @raw @levels_path |> File.read!() |> Jason.decode!()

  @schema @raw["schema"]
  @viewport {@raw["viewport"]["w"], @raw["viewport"]["h"]}
  @sector {@raw["sector"]["w"], @raw["sector"]["h"]}

  @levels Enum.map(@raw["levels"], fn lvl ->
            %{
              index: lvl["index"],
              name: lvl["name"],
              cols: lvl["cols"],
              rows: lvl["rows"],
              world_w: lvl["worldW"],
              world_h: lvl["worldH"],
              fares: lvl["fares"],
              policy: %{
                active_fares: lvl["policy"]["activeFares"],
                refill_on: lvl["policy"]["refillOn"],
                refill_delay: lvl["policy"]["refillDelay"]
              },
              pads:
                Enum.map(lvl["pads"], fn pad ->
                  %{
                    index: pad["index"],
                    x: pad["x"],
                    y: pad["y"],
                    w: pad["w"],
                    label: pad["label"]
                  }
                end)
            }
          end)

  @doc "The data format version. A client on a different one is rejected."
  def schema, do: @schema

  @doc "Viewport size in world units, as `{w, h}`."
  def viewport, do: @viewport

  @doc "Sector size in world units, as `{w, h}`."
  def sector, do: @sector

  @doc "Every level, in client order."
  def all, do: @levels

  @doc "One level by index, or nil."
  def get(index) when is_integer(index), do: Enum.at(@levels, index)

  @doc "The pads of one level."
  def pads(index) do
    case get(index) do
      nil -> []
      lvl -> lvl.pads
    end
  end
end
