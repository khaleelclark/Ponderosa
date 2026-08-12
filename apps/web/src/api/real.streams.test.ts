import type {
  AgentStreamStatusDto,
  SseEventEnvelope,
  WorkspaceEventEnvelope,
  WorkspaceStreamStatusDto,
} from "@ponderosa/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamSubscription } from "./types";
import { realApi } from "./real";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly close = vi.fn();
  readonly listeners = new Map<string, EventListener[]>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(
      typeof listener === "function"
        ? listener
        : (event) => listener.handleEvent(event),
    );
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("real API resilient streams", () => {
  it("reconnects an agent stream from the replay cursor after a canonical reset", () => {
    const onEvent = vi.fn();
    const subscription = realApi.subscribeAgent("agent-1", 100, { onEvent });
    const initial = FakeEventSource.instances[0]!;
    expect(initial.url).toBe("/api/agents/agent-1/stream?lastEventId=100");

    initial.emit("agent_status", {
      agentId: "agent-1",
      instanceId: "same-instance",
      cursor: 43,
      reset: true,
    } satisfies AgentStreamStatusDto);
    initial.emit("message", { seq: 1, replayed: true } as SseEventEnvelope);
    initial.emit("message", { seq: 43, replayed: true } as SseEventEnvelope);
    expect(onEvent).toHaveBeenCalledTimes(2);

    initial.fail();
    vi.advanceTimersByTime(500);
    expect(FakeEventSource.instances[1]!.url)
      .toBe("/api/agents/agent-1/stream?lastEventId=43");
    subscription.close();
  });

  it("reconnects a workspace stream from the replay cursor after a canonical reset", () => {
    const onEvent = vi.fn();
    const subscription = realApi.subscribeWorkspace(100, { onEvent });
    const initial = FakeEventSource.instances[0]!;
    expect(initial.url).toBe("/api/workspace/stream?lastEventId=100");

    initial.emit("workspace_status", {
      instanceId: "same-instance",
      cursor: 43,
      reset: true,
    } satisfies WorkspaceStreamStatusDto);
    initial.emit("message", { id: 1, replayed: true } as WorkspaceEventEnvelope);
    initial.emit("message", { id: 43, replayed: true } as WorkspaceEventEnvelope);
    expect(onEvent).toHaveBeenCalledTimes(2);

    initial.fail();
    vi.advanceTimersByTime(500);
    expect(FakeEventSource.instances[1]!.url)
      .toBe("/api/workspace/stream?lastEventId=43");
    subscription.close();
  });

  it("lets an instance-change handler cancel the wrapper and restart from zero", () => {
    let subscription: StreamSubscription;
    const onEvent = vi.fn();
    subscription = realApi.subscribeAgent("agent-1", 100, {
      onEvent,
      onStatus(status) {
        if (status.instanceId === "new-instance") subscription.close();
      },
    });
    const initial = FakeEventSource.instances[0]!;

    initial.emit("agent_status", {
      agentId: "agent-1",
      instanceId: "new-instance",
      cursor: 43,
      reset: false,
    } satisfies AgentStreamStatusDto);
    expect(initial.close).toHaveBeenCalledOnce();
    initial.fail();
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(1);

    const replacement = realApi.subscribeAgent("agent-1", 0, { onEvent });
    expect(FakeEventSource.instances[1]!.url)
      .toBe("/api/agents/agent-1/stream?lastEventId=0");
    replacement.close();
  });

  it("keeps ordinary agent cursor progression monotonic across reconnects", () => {
    const subscription = realApi.subscribeAgent("agent-1", 2, { onEvent: vi.fn() });
    const initial = FakeEventSource.instances[0]!;
    initial.emit("message", { seq: 4 } as SseEventEnvelope);
    initial.emit("message", { seq: 3 } as SseEventEnvelope);
    initial.emit("message", { seq: 5 } as SseEventEnvelope);

    initial.fail();
    vi.advanceTimersByTime(500);
    expect(FakeEventSource.instances[1]!.url)
      .toBe("/api/agents/agent-1/stream?lastEventId=5");
    subscription.close();
  });
});
