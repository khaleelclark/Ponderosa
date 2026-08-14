import type { FastifyInstance } from "fastify";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ProcessSignalHost {
  exitCode?: string | number | null;
  on(event: ShutdownSignal, listener: (signal: ShutdownSignal) => void): unknown;
  off(event: ShutdownSignal, listener: (signal: ShutdownSignal) => void): unknown;
}

/**
 * Route production OS termination through Fastify's complete close lifecycle.
 * No explicit process.exit() is used: Node may leave only after every referenced
 * provider termination barrier has settled and all server resources are closed.
 */
export function installProcessShutdownHandlers(
  app: Pick<FastifyInstance, "close" | "log"> & {
    prepareForShutdown?: () => void;
    retryShutdownCleanup?: () => Promise<void>;
    completeLauncherShutdownRecovery?: () => void;
  },
  host: ProcessSignalHost = process,
): () => void {
  let shutdown: Promise<void> | undefined;
  let fastifyCloseAttempted = false;
  const handle = (signal: ShutdownSignal): void => {
    if (shutdown) return;
    app.log.info({ signal }, "Ponderosa received an OS shutdown signal");
    const attempt = async (): Promise<void> => {
      if (!fastifyCloseAttempted) {
        fastifyCloseAttempted = true;
        try {
          app.prepareForShutdown?.();
          await app.close();
        } catch (error) {
          if (app.retryShutdownCleanup) {
            app.log.error({ err: error, signal }, "Ponderosa is retrying strict shutdown cleanup after Fastify close failed");
            try {
              await app.retryShutdownCleanup();
            } catch (retryError) {
              throw new AggregateError([error, retryError], "Ponderosa shutdown cleanup retry did not complete");
            }
          } else throw error;
        }
      }
      await app.retryShutdownCleanup?.();
      app.completeLauncherShutdownRecovery?.();
      host.exitCode = 0;
    };
    shutdown = attempt().catch((error: unknown) => {
      host.exitCode = 1;
      app.log.error({ err: error, signal }, "Ponderosa shutdown remains incomplete");
      throw error;
    }).finally(() => {
      // A later OS signal may retry retained handles after a genuine failure.
      if (host.exitCode === 1) shutdown = undefined;
    });
    // The process and provider handles remain live on failure. Observe the
    // rejection here so a signal-handler promise cannot become unhandled.
    void shutdown.catch(() => undefined);
  };
  host.on("SIGTERM", handle);
  host.on("SIGINT", handle);
  return () => {
    host.off("SIGTERM", handle);
    host.off("SIGINT", handle);
  };
}
