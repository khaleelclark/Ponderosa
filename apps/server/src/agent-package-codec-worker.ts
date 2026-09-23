import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";

type CodecWorkerInput =
  | { operation: "parse-file"; pathname: string }
  | { operation: "stringify-package"; portable: unknown };

try {
  const input = workerData as CodecWorkerInput;
  if (input.operation === "parse-file") {
    const body = readFileSync(input.pathname);
    const separator = body.indexOf(0x0a);
    if (separator < 1 || separator > 16 * 1024) {
      throw new Error("Agent package upload metadata is invalid");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const metadata = JSON.parse(decoder.decode(body.subarray(0, separator)));
    const portable = body.subarray(separator + 1);
    // Validate in the resource-limited worker, but transfer bytes rather than
    // structured-cloning the entire parsed object into the application heap.
    JSON.parse(decoder.decode(portable));
    const portableBytes = Uint8Array.from(portable).buffer;
    parentPort?.postMessage({ metadata, portableBytes }, [portableBytes]);
  } else {
    parentPort?.postMessage({
      body: JSON.stringify(input.portable),
    });
  }
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
}
