import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "./ChatSurface";

let resizeCallbacks: Array<() => void> = [];

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver));
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setScrollGeometry(
  element: HTMLElement,
  { clientHeight, scrollHeight, scrollTop }: {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
  },
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, value: scrollTop, writable: true },
  });
}

describe("ChatSurface viewport resizing", () => {
  it("keeps a latest-following chat anchored after the viewport changes", () => {
    render(
      <ChatSurface
        layout="project"
        layoutKey="latest"
        scrollTestId="chat-scroll"
      >
        <div>Latest message</div>
      </ChatSurface>,
    );
    const scroll = screen.getByTestId("chat-scroll");
    setScrollGeometry(scroll, {
      clientHeight: 320,
      scrollHeight: 1_200,
      scrollTop: 0,
    });

    resizeCallbacks.forEach(callback => callback());

    expect(scroll.scrollTop).toBe(1_200);
  });

  it("does not jump a reader who has scrolled away from latest", () => {
    render(
      <ChatSurface
        layout="project"
        layoutKey="history"
        scrollTestId="chat-scroll"
      >
        <div>Long message history</div>
      </ChatSurface>,
    );
    const scroll = screen.getByTestId("chat-scroll");
    setScrollGeometry(scroll, {
      clientHeight: 320,
      scrollHeight: 1_200,
      scrollTop: 180,
    });
    fireEvent.scroll(scroll);

    resizeCallbacks.forEach(callback => callback());

    expect(scroll.scrollTop).toBe(180);
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
  });
});
