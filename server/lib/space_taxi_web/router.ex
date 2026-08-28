defmodule SpaceTaxiWeb.Router do
  use SpaceTaxiWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", SpaceTaxiWeb do
    pipe_through :api
  end
end
