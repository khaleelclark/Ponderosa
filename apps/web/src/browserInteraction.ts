export interface BrowserScrollInput {
  kind: "scroll";
  deltaX: number;
  deltaY: number;
}

const MAX_BROWSER_SCROLL_DELTA = 4_000;

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
