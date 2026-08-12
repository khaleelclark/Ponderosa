import { afterEach, describe, expect, test, vi } from "vitest";
import { createWorkspaceRecencyInvalidator } from "./useWorkspaceStream";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("workspace recency live invalidation", () => {
  test("coalesces sustained events into one refetch per fixed window", () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const invalidator = createWorkspaceRecencyInvalidator(
      { invalidateQueries },
      350,
    );

    for (let index = 0; index < 1_000; index += 1) invalidator.schedule();
    vi.advanceTimersByTime(349);
    expect(invalidateQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 1_000; index += 1) invalidator.schedule();
    vi.advanceTimersByTime(350);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  test("cancels a pending refetch when a full reconciliation supersedes it", () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const invalidator = createWorkspaceRecencyInvalidator(
      { invalidateQueries },
      350,
    );

    invalidator.schedule();
    invalidator.dispose();
    vi.advanceTimersByTime(350);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
