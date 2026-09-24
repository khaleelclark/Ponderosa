import type { StreamSubscription } from "./types.js";

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 5_000;
// The server sends a heartbeat every 15 seconds. A half-open proxy response
// must not leave a mounted Chat silently stale forever.
const MAX_SILENCE_MS = 45_000;

interface ResilientEventSourceOptions {
  createSource(): EventSource;
  configure(source: EventSource): void;
  onOpen?(event: Event): void;
  onError?(event: Event): void;
  /** EventSource hides HTTP error headers. A bounded read-only probe can observe
   * a shared 429 Retry-After before reconnecting. */
  probeRateLimit?(): Promise<void>;
  reconnectCooldownMs?(): number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  maxSilenceMs?: number;
}

/**
 * EventSource does not reconnect after every HTTP failure (notably a 502 from
 * the local reverse proxy while the daemon is restarting). Own the retry loop
 * so a transient startup window cannot leave a mounted tab stale forever.
 */
export function createResilientEventSource(
  options: ResilientEventSourceOptions,
): StreamSubscription {
  const initialDelay = Math.max(1, options.initialReconnectDelayMs ?? INITIAL_RECONNECT_DELAY_MS);
  const maxDelay = Math.max(initialDelay, options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS);
  const maxSilence = Math.max(1, options.maxSilenceMs ?? MAX_SILENCE_MS);
  let stopped = false;
  let source: EventSource | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = initialDelay;

  const clearSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = undefined;
  };

  const disconnect = (current: EventSource, event: Event): void => {
    if (stopped || source !== current) return;
    clearSilenceTimer();
    options.onError?.(event);
    source = undefined;
    current.close();
    void (options.probeRateLimit?.() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => scheduleReconnect());
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = Math.max(reconnectDelay, options.reconnectCooldownMs?.() ?? 0);
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const noteActivity = (current: EventSource): void => {
    if (stopped || source !== current) return;
    clearSilenceTimer();
    silenceTimer = setTimeout(() => disconnect(current, new Event("error")), maxSilence);
  };

  const connect = (): void => {
    if (stopped) return;
    if ((options.reconnectCooldownMs?.() ?? 0) > 0) {
      scheduleReconnect();
      return;
    }
    const nextSource = options.createSource();
    source = nextSource;
    noteActivity(nextSource);
    nextSource.addEventListener("heartbeat", () => noteActivity(nextSource));
    nextSource.addEventListener("message", () => noteActivity(nextSource));
    nextSource.onopen = (event) => {
      if (stopped || source !== nextSource) return;
      reconnectDelay = initialDelay;
      noteActivity(nextSource);
      options.onOpen?.(event);
    };
    nextSource.onerror = (event) => disconnect(nextSource, event);
    options.configure(nextSource);
  };

  connect();
  return {
    close() {
      stopped = true;
      clearSilenceTimer();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      source?.close();
      source = undefined;
    },
  };
}
