// @vitest-environment node

import type { BrowserSessionDto } from "@ponderosa/core";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/browserInteraction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/browserInteraction")>();
  return {
    ...actual,
    decodeBrowserFrame: vi.fn(async () => "blob:frame"),
    createBrowserFrameScheduler: vi.fn(({ capture }: { capture(): Promise<void> }) => ({
      setVisible(visible: boolean) { if (visible) void capture(); },
      requestInteractionRefresh: vi.fn(),
      dispose: vi.fn(),
    })),
  };
});

import { BrowserViewport } from "../src/components/browser/BrowserViewport";
import type { BrowserEndpointAdapter } from "../src/components/browser/browserAdapters";

const session: BrowserSessionDto = {
  id: "browser-1",
  projectId: "project-1",
  agentId: "agent-1",
  runId: "run-1",
  status: "ready",
  controlOwner: "operator",
  controlEpoch: 3,
  url: "https://example.com",
  frameRevision: 1,
  openedAt: "2026-07-23T12:00:00.000Z",
  updatedAt: "2026-07-23T12:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("interactive browser viewport", () => {
  it("maps pointer, keyboard, wheel, and touch interactions into the fixed host viewport", async () => {
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("URL", { revokeObjectURL: vi.fn() });
    const adapter = {
      queryKey: ["browser"],
      get: vi.fn(),
      reconnect: vi.fn(),
      close: vi.fn(),
      setControl: vi.fn(),
      sendInput: vi.fn(),
      getFrame: vi.fn(async () => ({ blob: new Blob(), revision: 1 })),
    } as unknown as BrowserEndpointAdapter<BrowserSessionDto>;
    const sendInput = vi.fn();
    const refreshFrame = { current: vi.fn() };
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<BrowserViewport
        adapter={adapter}
        session={session}
        active
        operatorControl
        sendInput={sendInput}
        refreshFrame={refreshFrame}
      />);
    });
    await vi.waitFor(() => expect(view.root.findAllByType("img")).toHaveLength(1));
    const image = view.root.findByType("img");
    const target = {
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 640, height: 360 }),
      clientWidth: 640,
      clientHeight: 360,
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
    };
    act(() => image.props.onClick({ clientX: 420, clientY: 230, currentTarget: target }));
    expect(sendInput).toHaveBeenCalledWith({ kind: "click", x: 640, y: 360 });

    const preventDefault = vi.fn();
    act(() => image.props.onKeyDown({ key: "Enter", preventDefault }));
    expect(preventDefault).toHaveBeenCalled();
    expect(sendInput).toHaveBeenCalledWith({ kind: "key", key: "Enter" });
    act(() => image.props.onKeyDown({ key: "Tab", preventDefault }));
    expect(sendInput).not.toHaveBeenCalledWith({ kind: "key", key: "Tab" });

    act(() => image.props.onWheel({ deltaX: 1, deltaY: 2, deltaMode: 1, preventDefault, currentTarget: target }));
    expect(sendInput).toHaveBeenCalledWith({ kind: "scroll", deltaX: 32, deltaY: 64 });

    act(() => image.props.onPointerDown({ pointerType: "touch", pointerId: 7, clientX: 300, clientY: 300, currentTarget: target }));
    act(() => image.props.onPointerMove({ pointerId: 7, clientX: 280, clientY: 250, preventDefault, currentTarget: target }));
    expect(sendInput).toHaveBeenCalledWith({ kind: "scroll", deltaX: 40, deltaY: 100 });
    act(() => image.props.onPointerUp({ pointerId: 7, currentTarget: target }));
    expect(target.releasePointerCapture).toHaveBeenCalledWith(7);
    act(() => view.unmount());
  });

  it("removes the viewport from keyboard order when the Agent owns control", async () => {
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("URL", { revokeObjectURL: vi.fn() });
    const adapter = {
      queryKey: ["browser"],
      getFrame: vi.fn(async () => ({ blob: new Blob(), revision: 1 })),
    } as unknown as BrowserEndpointAdapter<BrowserSessionDto>;
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<BrowserViewport adapter={adapter} session={{ ...session, controlOwner: "agent" }} active operatorControl={false} sendInput={vi.fn()} refreshFrame={{ current: vi.fn() }} />);
    });
    await vi.waitFor(() => expect(view.root.findAllByType("img")).toHaveLength(1));
    expect(view.root.findByType("img").props.tabIndex).toBe(-1);
    expect(view.root.findByType("img").props["aria-label"]).toContain("Agent has control");
    act(() => view.unmount());
  });
});
