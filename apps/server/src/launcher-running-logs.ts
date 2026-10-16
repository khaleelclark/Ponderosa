import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "@ponderosa/native-host/fs";
import path from "node:path";

const LOG_BYTES = 5 * 1024 * 1024;
const ARCHIVES = 3;

/** Close every append before rotating; inherited stdout descriptors must not
 * keep sending server output into an archive after its pathname changes. */
export function boundedLogWriter(filename: string, maxBytes = LOG_BYTES, archives = ARCHIVES): (body: Buffer) => void {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  let size = existsSync(filename) ? statSync(filename).size : 0;
  const rotate = () => {
    rmSync(`${filename}.${archives}`, { force: true });
    for (let index = archives - 1; index >= 1; index--) {
      if (existsSync(`${filename}.${index}`)) renameSync(`${filename}.${index}`, `${filename}.${index + 1}`);
    }
    if (existsSync(filename)) renameSync(filename, `${filename}.1`);
    size = 0;
  };
  return body => {
    for (let offset = 0; offset < body.length;) {
      if (size >= maxBytes) rotate();
      const part = body.subarray(offset, offset + Math.min(body.length - offset, maxBytes - size));
      // Synchronous appends also bound queued log memory during slow disk I/O.
      appendFileSync(filename, part, { mode: 0o600 });
      offset += part.length;
      size += part.length;
    }
  };
}

export function installLauncherRunningLogs(launcherRoot: string | undefined): void {
  if (!launcherRoot) return;
  for (const [stream, name] of [[process.stdout, "server.log"], [process.stderr, "server-error.log"]] as const) {
    const write = boundedLogWriter(path.join(launcherRoot, "logs", name));
    stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
      const done = typeof encoding === "function" ? encoding : callback;
      write(typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk));
      if (done) queueMicrotask(() => done(null));
      return true;
    }) as typeof stream.write;
  }
}
