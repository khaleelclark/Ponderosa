import { createRoot } from "react-dom/client";
import { createRef } from "react";
import { BrowserViewport } from "../src/components/browser/BrowserViewport";

const nativeSetTimeout = window.setTimeout.bind(window);
window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
  nativeSetTimeout(callback, delay === 20_000 ? 150 : delay, ...args)) as typeof window.setTimeout;
const state = { opened: 0, closed: 0, polls: 0 };
(window as any).previewProbe = state;
(window as any).EventSource = class {
  constructor() { state.opened += 1; }
  addEventListener() {}
  close() { state.closed += 1; }
};
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), character => character.charCodeAt(0));
const session = { id: "preview", status: "ready", activePageId: "page", location: "hosted" } as any;
const adapter = {
  frameStreamUrl: () => "/silent-preview",
  getFrame: async () => {
    state.polls += 1;
    return { blob: new Blob([png], { type: "image/png" }), revision: 1,
      metadata: { pageId: "page", viewport: { width: 1, height: 1 } } };
  },
} as any;
createRoot(document.getElementById("root")!).render(<BrowserViewport
  adapter={adapter} session={session} active pollingEnabled operatorControl={false}
  preferBinary={false} sendInput={() => {}} refreshFrame={createRef<() => void>()}
/>);
