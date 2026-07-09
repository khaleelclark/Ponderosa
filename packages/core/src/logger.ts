// Minimal structured logger. Node-only; behind a subpath export, not in the barrel.
// The Fastify daemon uses pino for HTTP logging; this is a lightweight logger for
// library code (engines, threads, CLI harness) that shouldn't depend on Fastify.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Derive a logger that prefixes every line with the given bindings. */
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Static fields merged into every log line. */
  bindings?: Record<string, unknown>;
}

function resolveLevel(explicit?: LogLevel): LogLevel {
  if (explicit) return explicit;
  const env = process.env.PONDEROSA_LOG_LEVEL as LogLevel | undefined;
  if (env && env in LEVEL_ORDER) return env;
  return "info";
}

/** Create a console-backed logger that emits one JSON line per record. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = resolveLevel(opts.level);
  const threshold = LEVEL_ORDER[level];
  const baseBindings = opts.bindings ?? {};

  function emit(lvl: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const record = {
      level: lvl,
      time: new Date().toISOString(),
      msg,
      ...baseBindings,
      ...(meta ?? {}),
    };
    const line = JSON.stringify(record);
    if (lvl === "error" || lvl === "warn") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
    child: (bindings) =>
      createLogger({ level, bindings: { ...baseBindings, ...bindings } }),
  };
}
