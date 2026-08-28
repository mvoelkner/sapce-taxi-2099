defmodule SpaceTaxiWeb.ChannelCase do
  @moduledoc """
  Test case for channels. Sets up the endpoint so `subscribe_and_join` works.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      import Phoenix.ChannelTest
      import SpaceTaxiWeb.ChannelCase

      @endpoint SpaceTaxiWeb.Endpoint
    end
  end
end
