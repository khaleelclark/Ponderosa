import type { StreamSubscription } from "./types";

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 5_000;

interface ResilientEventSourceOptions {
  createSource(): EventSource;
  configure(source: EventSource): void;
  onOpen?(event: Event): void;
  onError?(event: Event): void;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
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
  let stopped = false;
  let source: EventSource | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = initialDelay;

  const connect = (): void => {
    if (stopped) return;
    const nextSource = options.createSource();
    source = nextSource;
    nextSource.onopen = (event) => {
      if (stopped || source !== nextSource) return;
      reconnectDelay = initialDelay;
      options.onOpen?.(event);
    };
    nextSource.onerror = (event) => {
      if (stopped || source !== nextSource) return;
      options.onError?.(event);
      source = undefined;
      nextSource.close();
      if (reconnectTimer) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };
    options.configure(nextSource);
  };

  connect();
  return {
    close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      source?.close();
      source = undefined;
    },
  };
}
