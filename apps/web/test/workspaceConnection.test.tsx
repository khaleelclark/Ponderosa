import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import type { WorkspaceStreamHandlers } from "../src/api/types";
import { useWorkspaceStream } from "../src/hooks/useWorkspaceStream";

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const subscriptions: Array<{
    cursor: number | undefined;
    handlers: WorkspaceStreamHandlers;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  vi.spyOn(api, "subscribeWorkspace").mockImplementation((cursor, handlers) => {
    const subscription = { cursor, handlers, close: vi.fn() };
    subscriptions.push(subscription);
    return subscription;
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useWorkspaceStream(), { wrapper });
  return { client, hook, subscriptions };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("workspace live connection state", () => {
  it("suppresses short reconnect noise and reconciles once the stream resumes", async () => {
    vi.useFakeTimers();
    const { client, hook, subscriptions } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const stream = subscriptions[0]!;

    act(() => stream.handlers.onStatus?.({
      instanceId: "server-a",
      cursor: 0,
      reset: false,
    }));
    expect(hook.result.current.status).toBe("live");

    act(() => {
      stream.handlers.onError?.(new Event("error"));
      vi.advanceTimersByTime(500);
      stream.handlers.onStatus?.({
        instanceId: "server-a",
        cursor: 0,
        reset: false,
      });
    });
    expect(hook.result.current).toMatchObject({
      status: "live",
      prolongedDisconnect: false,
    });
    expect(hook.result.current.announcement).toBeUndefined();
    expect(invalidate).toHaveBeenCalled();
  });

  it("reports reconnecting and stale states, then announces recovery", () => {
    vi.useFakeTimers();
    const { hook, subscriptions } = setup();
    const stream = subscriptions[0]!;
    act(() => stream.handlers.onStatus?.({
      instanceId: "server-a",
      cursor: 0,
      reset: false,
    }));

    act(() => {
      stream.handlers.onError?.(new Event("error"));
      vi.advanceTimersByTime(1_000);
    });
    expect(hook.result.current.status).toBe("reconnecting");

    act(() => vi.advanceTimersByTime(7_000));
    expect(hook.result.current).toMatchObject({
      status: "stale",
      prolongedDisconnect: true,
      announcement: "Live workspace updates are unavailable.",
    });

    act(() => stream.handlers.onStatus?.({
      instanceId: "server-a",
      cursor: 0,
      reset: false,
    }));
    expect(hook.result.current).toMatchObject({
      status: "live",
      prolongedDisconnect: false,
      announcement: "Live workspace updates have resumed.",
    });
  });

  it("resets the cursor and reconnects after a server-instance change", () => {
    vi.useFakeTimers();
    const { subscriptions } = setup();
    const stream = subscriptions[0]!;
    act(() => stream.handlers.onStatus?.({
      instanceId: "server-a",
      cursor: 12,
      reset: false,
    }));
    act(() => stream.handlers.onStatus?.({
      instanceId: "server-b",
      cursor: 0,
      reset: true,
    }));
    expect(stream.close).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(50));
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]?.cursor).toBe(0);
  });

  it("reconciles a replay gap instead of projecting partial state", () => {
    const { client, subscriptions } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    act(() => subscriptions[0]?.handlers.onEvent({
      id: 4,
      ts: "2026-08-04T12:00:00.000Z",
      event: {
        type: "project_changed",
        projectId: "project-1",
        action: "used",
      },
      replayed: true,
    } as never));
    expect(invalidate).toHaveBeenCalled();
  });
});
