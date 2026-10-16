export interface BrowserScrollInput {
  kind: "scroll";
  deltaX: number;
  deltaY: number;
}

const MAX_BROWSER_SCROLL_DELTA = 4_000;
const MAX_COALESCED_SCROLL_DELTA = 480;
const BROWSER_FRAME_ACTIVE_INTERVAL_MS = 75;
const BROWSER_FRAME_IDLE_INTERVAL_MS = 750;
const BROWSER_FRAME_ACTIVE_WINDOW_MS = 3_000;

function clampScrollDelta(value: number): number {
  return Math.max(-MAX_BROWSER_SCROLL_DELTA, Math.min(MAX_BROWSER_SCROLL_DELTA, value));
}

export function normalizeBrowserWheelDelta(delta: number, deltaMode: number, pageSize: number): number {
  const scaled = deltaMode === 1 ? delta * 32 : deltaMode === 2 ? delta * pageSize : delta;
  return clampScrollDelta(scaled);
}

export function mergeBrowserScrollInputs(
  current: BrowserScrollInput | undefined,
  next: BrowserScrollInput,
): BrowserScrollInput {
  return {
    kind: "scroll",
    deltaX: clampScrollDelta((current?.deltaX ?? 0) + next.deltaX),
    deltaY: clampScrollDelta((current?.deltaY ?? 0) + next.deltaY),
  };
}

export function coalesceBrowserScrollInputs(
  current: BrowserScrollInput,
  next: BrowserScrollInput,
): BrowserScrollInput | undefined {
  // Keep each visual step moderate even when a trackpad emits many events
  // during one screenshot, and never clamp away any of the gesture.
  if (Math.abs(current.deltaX + next.deltaX) > MAX_COALESCED_SCROLL_DELTA ||
      Math.abs(current.deltaY + next.deltaY) > MAX_COALESCED_SCROLL_DELTA) return undefined;
  return mergeBrowserScrollInputs(current, next);
}

export function browserTouchScrollDelta(previous: number, current: number): number {
  return clampScrollDelta((previous - current) * 2);
}

function browserFrameRefreshDelay(now: number, activeUntil: number): number {
  return now < activeUntil ? BROWSER_FRAME_ACTIVE_INTERVAL_MS : BROWSER_FRAME_IDLE_INTERVAL_MS;
}

export interface BrowserFrameScheduler {
  setVisible(visible: boolean): void;
  requestInteractionRefresh(): void;
  dispose(): void;
}

export function createBrowserFrameScheduler({
  capture,
  now = () => Date.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (timer) => window.clearTimeout(timer),
}: {
  capture(): Promise<void>;
  now?(): number;
  setTimer?(callback: () => void, delay: number): number;
  clearTimer?(timer: number): void;
}): BrowserFrameScheduler {
  let visible = false;
  let disposed = false;
  let running = false;
  let activeUntil = 0;
  let lastCompletedAt = -Infinity;
  let timer: number | undefined;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const schedule = (delay: number) => {
    if (!visible || disposed) return;
    cancelTimer();
    timer = setTimer(() => {
      timer = undefined;
      void run();
    }, delay);
  };
  const run = async (): Promise<void> => {
    if (!visible || disposed) return;
    if (running) return;
    running = true;
    try {
      await capture();
    } catch {
      // The capture surface owns user-facing errors; cadence must survive one failed frame.
    } finally {
      running = false;
      if (!visible || disposed) return;
      lastCompletedAt = now();
      // A burst of wheel events should not cause a screenshot after every
      // acknowledged input. Keep the active cadence bounded and leave the
      // browser's action queue room to apply pending input.
      const delay = browserFrameRefreshDelay(lastCompletedAt, activeUntil);
      schedule(delay);
    }
  };

  return {
    setVisible(nextVisible) {
      if (disposed || visible === nextVisible) return;
      visible = nextVisible;
      cancelTimer();
      if (visible) void run();
    },
    requestInteractionRefresh() {
      if (disposed) return;
      activeUntil = Math.max(activeUntil, now() + BROWSER_FRAME_ACTIVE_WINDOW_MS);
      if (visible && !running) schedule(Math.max(0, lastCompletedAt + BROWSER_FRAME_ACTIVE_INTERVAL_MS - now()));
    },
    dispose() {
      disposed = true;
      visible = false;
      cancelTimer();
    },
  };
}

/** Decode a frame for a persistent canvas. SVG test/legacy frames and browsers
 * without createImageBitmap still use an Image, without replacing the DOM node. */
export async function decodeBrowserFrameSurface(blob: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}> {
  if (typeof createImageBitmap === "function" && blob.type !== "image/svg+xml") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Some WebKit versions advertise createImageBitmap but reject JPEG
      // blobs. Keep the ordinary image decoder as the compatibility path.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Decode at most one frame at a time. During a burst, retain only the newest
 * waiting frame so display latency does not grow behind obsolete pixels. */
export function createLatestBrowserFrameQueue<T>(consume: (frame: T) => Promise<void>, onError: (error: unknown) => void) {
  let latest: { value: T } | undefined;
  let running = false;
  let disposed = false;
  const drain = async () => {
    if (running) return;
    running = true;
    while (!disposed && latest) {
      const current = latest;
      latest = undefined;
      try { await consume(current.value); }
      catch (error) { onError(error); }
    }
    running = false;
  };
  return {
    push(frame: T) {
      if (disposed) return;
      latest = { value: frame };
      void drain();
    },
    dispose() { disposed = true; latest = undefined; },
  };
}

export function parseBrowserFrameEvent(data: string): { blob: Blob; metadata: import("@ponderosa/core").BrowserFrameMetadata } {
  if (data.length > 2 * 1024 * 1024) throw new Error("Browser preview frame is too large.");
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== "object") throw new Error("Browser preview frame is invalid.");
  const frame = value as Record<string, unknown>;
  const metadata = frame.metadata as import("@ponderosa/core").BrowserFrameMetadata | undefined;
  if ((frame.mediaType !== "image/jpeg" && frame.mediaType !== "image/png") ||
      typeof frame.data !== "string" || !metadata || typeof metadata.pageId !== "string" ||
      !metadata.viewport || !Number.isFinite(metadata.viewport.width) || !Number.isFinite(metadata.viewport.height) ||
      metadata.viewport.width <= 0 || metadata.viewport.height <= 0) {
    throw new Error("Browser preview frame is invalid.");
  }
  const binary = atob(frame.data);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (!bytes.length || bytes.length > 1_500_000) throw new Error("Browser preview frame is too large.");
  return { blob: new Blob([bytes], { type: frame.mediaType }), metadata };
}

/** Binary preview packets: 32-bit metadata length, 32-bit frame length,
 * UTF-8 metadata JSON, then the JPEG/PNG bytes. Zero lengths are a heartbeat. */
export function createBrowserBinaryFrameParser() {
  let pending = new Uint8Array(8);
  let used = 0;
  let expected = 8;
  let metadataLength = 0;
  let imageLength = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    push(chunk: Uint8Array): Array<{ blob: Blob; metadata: import("@ponderosa/core").BrowserFrameMetadata }> {
      const frames: Array<{ blob: Blob; metadata: import("@ponderosa/core").BrowserFrameMetadata }> = [];
      let offset = 0;
      while (offset < chunk.length) {
        if (pending.length < expected) {
          const grown = new Uint8Array(expected);
          grown.set(pending.subarray(0, used));
          pending = grown;
        }
        const take = Math.min(expected - used, chunk.length - offset);
        pending.set(chunk.subarray(offset, offset + take), used);
        used += take;
        offset += take;
        if (used < expected) break;
        if (expected === 8) {
          const header = new DataView(pending.buffer, pending.byteOffset, 8);
          metadataLength = header.getUint32(0);
          imageLength = header.getUint32(4);
          if (metadataLength === 0 && imageLength === 0) { used = 0; continue; }
          if (metadataLength === 0 || metadataLength > 4_096 || imageLength === 0 || imageLength > 1_500_000) throw new Error("Browser preview frame is invalid.");
          expected = 8 + metadataLength + imageLength;
          continue;
        }
        const value: unknown = JSON.parse(decoder.decode(pending.subarray(8, 8 + metadataLength)));
        if (!value || typeof value !== "object") throw new Error("Browser preview frame is invalid.");
        const frame = value as Record<string, unknown>;
        const metadata = frame.metadata as import("@ponderosa/core").BrowserFrameMetadata | undefined;
        if ((frame.mediaType !== "image/jpeg" && frame.mediaType !== "image/png") || !metadata || typeof metadata.pageId !== "string" ||
            !metadata.viewport || !Number.isFinite(metadata.viewport.width) || !Number.isFinite(metadata.viewport.height) ||
            metadata.viewport.width <= 0 || metadata.viewport.height <= 0) throw new Error("Browser preview frame is invalid.");
        frames.push({ blob: new Blob([pending.slice(8 + metadataLength, expected)], { type: frame.mediaType }), metadata });
        used = 0;
        expected = 8;
      }
      return frames;
    },
  };
}
