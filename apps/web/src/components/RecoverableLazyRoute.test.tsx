import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  RecoverableLazyRoute,
  type LazyRouteLoad,
} from "./RecoverableLazyRoute";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("recoverable lazy workspace routes", () => {
  test("replaces React.lazy's cached rejection for one explicit retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn<LazyRouteLoad<{ label: string }>>()
      .mockRejectedValueOnce(new Error("stale route chunk"))
      .mockResolvedValueOnce({
        default: ({ label }) => <div data-testid="loaded-route">{label}</div>,
      });

    render(
      <RecoverableLazyRoute
        load={load}
        componentProps={{ label: "Recovered route" }}
        routeMarker={{ kind: "settings", path: "/settings" }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Try Again" }));

    expect(await screen.findByTestId("loaded-route")).not.toBeNull();
    expect(screen.getByTestId("loaded-route").textContent).toBe("Recovered route");
    const routeContent = document.querySelector('[data-workspace-route-kind="settings"][data-workspace-route-content]');
    expect(routeContent?.textContent).toContain("Recovered route");
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("bounds in-app retries and never reloads without a user action", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn<LazyRouteLoad<Record<string, never>>>()
      .mockRejectedValue(new Error("chunk remains unavailable"));
    const reload = vi.fn();

    render(
      <RecoverableLazyRoute
        load={load}
        componentProps={{}}
        routeMarker={{ kind: "settings", path: "/settings" }}
        reload={reload}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Try Again" }));
    const reloadButton = await screen.findByRole("button", { name: "Reload Ponderosa" });

    expect(load).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector("[data-workspace-route-kind]")).toBeNull();
    fireEvent.click(reloadButton);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
