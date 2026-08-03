import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPane } from "../src/components/chat/ChatPane";
import { ChatSurface } from "../src/components/chat/ChatSurface";

class ObservableResizeObserver {
  static instances: ObservableResizeObserver[] = [];

  readonly observed: Element[] = [];
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    ObservableResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {}

  resize(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function surfaceProps(
  overrides: Partial<ComponentProps<typeof ChatSurface>> = {},
): ComponentProps<typeof ChatSurface> {
  return {
    layout: "project",
    layoutKey: "layout-one",
    scrollTestId: "chat-viewport",
    children: <div>Message</div>,
    ...overrides,
  };
}

function controllableViewport(): {
  viewport: HTMLElement;
  setScrollHeight(value: number): void;
  setClientHeight(value: number): void;
} {
  const viewport = screen.getByTestId("chat-viewport");
  let scrollHeight = 1_000;
  let clientHeight = 400;
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
  });
  return {
    viewport,
    setScrollHeight: value => { scrollHeight = value; },
    setClientHeight: value => { clientHeight = value; },
  };
}

beforeEach(() => {
  ObservableResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", ObservableResizeObserver);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared chat scroll stability", () => {
  it("observes the inner content without recreating the observer for layout changes", () => {
    const view = render(<ChatSurface {...surfaceProps()} />);
    const viewport = screen.getByTestId("chat-viewport");
    const content = viewport.querySelector("[data-chat-content='true']");

    expect(content).toBeTruthy();
    expect(ObservableResizeObserver.instances).toHaveLength(1);
    expect(ObservableResizeObserver.instances[0]!.observed).toEqual([content]);
    expect(ObservableResizeObserver.instances[0]!.observed).not.toContain(viewport);

    view.rerender(
      <ChatSurface {...surfaceProps({ layoutKey: "layout-two" })} />,
    );
    expect(ObservableResizeObserver.instances).toHaveLength(1);

    view.unmount();
    expect(ObservableResizeObserver.instances[0]!.disconnect)
      .toHaveBeenCalledOnce();
  });

  it("pins content growth and shrinkage only while following latest", () => {
    render(<ChatSurface {...surfaceProps()} />);
    const { viewport, setScrollHeight } = controllableViewport();
    const observer = ObservableResizeObserver.instances[0]!;

    viewport.scrollTop = 600;
    fireEvent.scroll(viewport);
    setScrollHeight(1_200);
    act(() => observer.resize());
    expect(viewport.scrollTop).toBe(1_200);

    setScrollHeight(800);
    act(() => observer.resize());
    expect(viewport.scrollTop).toBe(800);

    setScrollHeight(1_000);
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    setScrollHeight(1_300);
    act(() => observer.resize());
    expect(viewport.scrollTop).toBe(200);
    expect(screen.getByRole("button", { name: "Jump to latest message" }))
      .toBeTruthy();
  });

  it("disables resize following without disabling explicit layout following", () => {
    const view = render(
      <ChatSurface
        {...surfaceProps({ follow: { kind: "latest", followResizes: false } })}
      />,
    );
    const { viewport, setScrollHeight } = controllableViewport();
    expect(ObservableResizeObserver.instances).toHaveLength(0);

    viewport.scrollTop = 600;
    fireEvent.scroll(viewport);
    setScrollHeight(1_200);
    view.rerender(
      <ChatSurface
        {...surfaceProps({
          layoutKey: "layout-two",
          follow: { kind: "latest", followResizes: false },
        })}
      />,
    );
    expect(viewport.scrollTop).toBe(1_200);
  });

  it("follows a new layout key only when the user was already following", () => {
    const view = render(<ChatSurface {...surfaceProps()} />);
    const { viewport, setScrollHeight } = controllableViewport();

    viewport.scrollTop = 600;
    fireEvent.scroll(viewport);
    setScrollHeight(1_200);
    view.rerender(
      <ChatSurface {...surfaceProps({ layoutKey: "layout-two" })} />,
    );
    expect(viewport.scrollTop).toBe(1_200);

    viewport.scrollTop = 300;
    fireEvent.scroll(viewport);
    setScrollHeight(1_500);
    view.rerender(
      <ChatSurface {...surfaceProps({ layoutKey: "layout-three" })} />,
    );
    expect(viewport.scrollTop).toBe(300);
  });

  it("preserves the viewed position when older history is prepended", () => {
    const loadEarlier = vi.fn();
    const view = render(
      <ChatSurface
        {...surfaceProps({
          history: {
            kind: "cursor",
            hasEarlier: true,
            loading: false,
            onLoadEarlier: loadEarlier,
          },
        })}
      />,
    );
    const { viewport, setScrollHeight } = controllableViewport();
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);

    fireEvent.click(screen.getByRole("button", { name: "Load Older History" }));
    expect(loadEarlier).toHaveBeenCalledOnce();
    setScrollHeight(1_300);
    view.rerender(
      <ChatSurface
        {...surfaceProps({
          layoutKey: "layout-with-older-history",
          history: {
            kind: "cursor",
            hasEarlier: true,
            loading: false,
            onLoadEarlier: loadEarlier,
          },
        })}
      />,
    );

    expect(viewport.scrollTop).toBe(500);
  });

  it("keeps Agent Chat on the shared inner-content surface", () => {
    render(<ChatPane messages={[]} />);
    const viewport = screen.getByLabelText("Conversation");
    expect(viewport.querySelector("[data-chat-content='true']")).toBeTruthy();
  });
});
