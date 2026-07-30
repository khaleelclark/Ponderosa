import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { readSecureFile } from "./index.js";

interface SecureFileWorkerInput {
  root: string;
  relativePath: string;
  maxBytes: number;
  requireNonEmpty?: boolean;
  expectedSize?: number;
  expectedSha256?: string;
}

const input = workerData as SecureFileWorkerInput;

try {
  const body = readSecureFile(input);
  const exact =
    body !== undefined &&
    (input.expectedSize === undefined || body.length === input.expectedSize) &&
    (input.expectedSha256 === undefined ||
      createHash("sha256").update(body).digest("hex") === input.expectedSha256);
  if (!exact) {
    parentPort?.postMessage({});
  } else {
    const transferable = new Uint8Array(body.length);
    transferable.set(body);
    parentPort?.postMessage(
      { body: transferable },
      [transferable.buffer],
    );
  }
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
}
