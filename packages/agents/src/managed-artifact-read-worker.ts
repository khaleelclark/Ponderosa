import { createHash } from "node:crypto";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { readSecureFile } from "@ponderosa/native-host";

interface ReadEntry {
  artifactId: string;
  expectedSize: number;
  expectedSha256: string;
}

interface ReadWorkerInput {
  dataDir: string;
  projectId: string;
  entries: ReadEntry[];
}

try {
  const input = workerData as ReadWorkerInput;
  const bodies = input.entries.map((entry) => {
    const body = readSecureFile({
      root: input.dataDir,
      relativePath: path.posix.join("projects", input.projectId, "artifacts", "content", entry.artifactId),
      maxBytes: entry.expectedSize,
      requireNonEmpty: true,
    });
    if (!body || body.length !== entry.expectedSize ||
        createHash("sha256").update(body).digest("hex") !== entry.expectedSha256) {
      return undefined;
    }
    const transferable = new Uint8Array(body.length);
    transferable.set(body);
    return transferable;
  });
  parentPort?.postMessage({ bodies }, bodies.flatMap((body) =>
    body ? [body.buffer as ArrayBuffer] : []));
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
