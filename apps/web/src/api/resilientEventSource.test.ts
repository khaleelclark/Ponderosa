import { afterEach, describe, expect, it, vi } from "vitest";
import { createResilientEventSource } from "./resilientEventSource";

class FakeEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly close = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resilient EventSource", () => {
  it("recreates a stream after a terminal HTTP failure and resets backoff on open", () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const onOpen = vi.fn();
    const onError = vi.fn();
    const subscription = createResilientEventSource({
      createSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      },
      configure: vi.fn(),
      onOpen,
      onError,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 40,
    });

    sources[0]!.onerror!(new Event("error"));
    expect(sources[0]!.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(9);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);

    sources[1]!.onerror!(new Event("error"));
    vi.advanceTimersByTime(19);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);
    sources[2]!.onopen!(new Event("open"));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(2);

    sources[2]!.onerror!(new Event("error"));
    vi.advanceTimersByTime(10);
    expect(sources).toHaveLength(4);
    subscription.close();
  });

  it("cancels a pending reconnect when the consumer closes", () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const subscription = createResilientEventSource({
      createSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      },
      configure: vi.fn(),
      initialReconnectDelayMs: 10,
    });

    sources[0]!.onerror!(new Event("error"));
    subscription.close();
    vi.runAllTimers();
    expect(sources).toHaveLength(1);
  });

  it("ignores duplicate browser error delivery from the replaced source", () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const onError = vi.fn();
    const subscription = createResilientEventSource({
      createSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      },
      configure: vi.fn(),
      onError,
      initialReconnectDelayMs: 10,
    });

    const duplicateError = new Event("error");
    sources[0]!.onerror!(duplicateError);
    sources[0]!.onerror!(duplicateError);

    expect(onError).toHaveBeenCalledOnce();
    expect(sources[0]!.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10);
    expect(sources).toHaveLength(2);
    subscription.close();
  });

  it("opens only one replacement when a hidden-tab timer is delivered late", () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const sources: FakeEventSource[] = [];
    const subscription = createResilientEventSource({
      createSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      },
      configure: vi.fn(),
      initialReconnectDelayMs: 10,
    });

    sources[0]!.onerror!(new Event("error"));
    expect(sources).toHaveLength(1);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10);
    expect(sources).toHaveLength(2);
    vi.runOnlyPendingTimers();
    expect(sources).toHaveLength(2);
    subscription.close();
  });
});
