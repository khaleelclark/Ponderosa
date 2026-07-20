export interface BrowserScrollInput {
  kind: "scroll";
  deltaX: number;
  deltaY: number;
}

const MAX_BROWSER_SCROLL_DELTA = 4_000;
export const BROWSER_FRAME_ACTIVE_INTERVAL_MS = 75;
export const BROWSER_FRAME_IDLE_INTERVAL_MS = 750;
export const BROWSER_FRAME_ACTIVE_WINDOW_MS = 3_000;

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

export function browserTouchScrollDelta(previous: number, current: number): number {
  return clampScrollDelta((previous - current) * 2);
}

export function browserFrameRefreshDelay(now: number, activeUntil: number): number {
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
  let immediateRequested = false;
  let activeUntil = 0;
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
    if (running) { immediateRequested = true; return; }
    running = true;
    immediateRequested = false;
    try {
      await capture();
    } catch {
      // The capture surface owns user-facing errors; cadence must survive one failed frame.
    } finally {
      running = false;
      if (!visible || disposed) return;
      const delay = immediateRequested ? 0 : browserFrameRefreshDelay(now(), activeUntil);
      immediateRequested = false;
      schedule(delay);
    }
  };

  return {
    setVisible(nextVisible) {
      if (disposed || visible === nextVisible) return;
      visible = nextVisible;
      cancelTimer();
      if (visible) void run();
      else immediateRequested = false;
    },
    requestInteractionRefresh() {
      if (disposed) return;
      activeUntil = Math.max(activeUntil, now() + BROWSER_FRAME_ACTIVE_WINDOW_MS);
      immediateRequested = true;
      cancelTimer();
      if (visible) void run();
    },
    dispose() {
      disposed = true;
      visible = false;
      immediateRequested = false;
      cancelTimer();
    },
  };
}

export async function decodeBrowserFrame(blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Browser frame could not be decoded."));
      image.src = url;
    });
    return url;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
