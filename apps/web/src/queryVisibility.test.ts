import { describe, expect, test, vi } from "vitest";
import { invalidateForBrowserPage } from "./queryVisibility";

describe("browser-page query invalidation", () => {
  test("marks hidden-page Agent data stale without refetching it", () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    invalidateForBrowserPage(
      { invalidateQueries } as never,
      ["agents", "detail", "agent-1"],
      false,
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["agents", "detail", "agent-1"],
      refetchType: "none",
    });
  });

  test("allows an active visible page to reconcile immediately", () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    invalidateForBrowserPage(
      { invalidateQueries } as never,
      ["agents", "detail", "agent-1"],
      true,
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["agents", "detail", "agent-1"],
    });
  });
});
