import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
  AgentPortablePackageDto,
  ImportAgentPackageRequest,
} from "@ponderosa/core";

function workerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../dist/agent-package-codec-worker.js", import.meta.url)
    : new URL("./agent-package-codec-worker.js", import.meta.url);
}

function transferableBytes(source: Buffer): Uint8Array {
  const body = new Uint8Array(source.length);
  body.set(source);
  return body;
}

function runCodecWorker<T>(
  workerData: object,
  transferList: ArrayBuffer[] = [],
): Promise<T> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl(), { workerData, transferList });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (outcome: T & { error?: string }): void => {
      if (settled) return;
      settled = true;
      worker.removeAllListeners();
      void worker.terminate();
      if (outcome.error) reject(new Error(outcome.error));
      else resolve(outcome);
    };
    worker.once("message", finish);
    worker.once("error", (error) => finish({ error: error.message } as T & {
      error: string;
    }));
    worker.once("exit", (code) => {
      if (!settled) {
        finish({
          error: `Agent package codec worker exited without a result (code ${code})`,
        } as T & { error: string });
      }
    });
  });
}

export async function encodePortableArtifact(
  source: Buffer,
): Promise<string> {
  return source.toString("base64");
}

export async function decodePortableArtifact(
  dataBase64: string,
): Promise<{ data: Buffer; sha256: string }> {
  const data = Buffer.from(dataBase64, "base64");
  if (
    data.toString("base64").replace(/=+$/u, "") !==
    dataBase64.replace(/=+$/u, "")
  ) {
    throw new Error("portable artifact has invalid base64 data");
  }
  return {
    data,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

export async function parsePortablePackageUpload(
  source: Buffer,
): Promise<{
  metadata: Omit<ImportAgentPackageRequest, "package">;
  portable: AgentPortablePackageDto;
}> {
  const body = transferableBytes(source);
  return runCodecWorker({
    operation: "parse-upload",
    body,
  }, [body.buffer as ArrayBuffer]);
}

export async function stringifyPortablePackage(
  portable: AgentPortablePackageDto,
): Promise<string> {
  const result = await runCodecWorker<{ body: string }>({
    operation: "stringify-package",
    portable,
  });
  return result.body;
}
