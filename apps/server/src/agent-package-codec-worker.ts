import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

type CodecWorkerInput =
  | { operation: "encode"; body: Uint8Array }
  | { operation: "decode"; dataBase64: string }
  | { operation: "parse-upload"; body: Uint8Array }
  | { operation: "stringify-package"; portable: unknown };

try {
  const input = workerData as CodecWorkerInput;
  if (input.operation === "encode") {
    parentPort?.postMessage({
      dataBase64: Buffer.from(input.body).toString("base64"),
    });
  } else if (input.operation === "decode") {
    const body = Buffer.from(input.dataBase64, "base64");
    if (
      body.toString("base64").replace(/=+$/u, "") !==
      input.dataBase64.replace(/=+$/u, "")
    ) {
      throw new Error("portable artifact has invalid base64 data");
    }
    const transferable = new Uint8Array(body.length);
    transferable.set(body);
    parentPort?.postMessage({
      body: transferable,
      sha256: createHash("sha256").update(body).digest("hex"),
    }, [transferable.buffer]);
  } else if (input.operation === "parse-upload") {
    const body = Buffer.from(input.body);
    const separator = body.indexOf(0x0a);
    if (separator < 1 || separator > 16 * 1024) {
      throw new Error("Agent package upload metadata is invalid");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    parentPort?.postMessage({
      metadata: JSON.parse(decoder.decode(body.subarray(0, separator))),
      portable: JSON.parse(decoder.decode(body.subarray(separator + 1))),
    });
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
