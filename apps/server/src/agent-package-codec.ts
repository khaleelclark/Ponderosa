import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
  AgentPortablePackageDto,
  ImportAgentPackageRequest,
} from "@ponderosa/core";

const CODEC_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_CODECS = 1;
const MAX_CONCURRENT_IMPORTS = 1;
let activeCodecs = 0;
const codecWaiters: Array<() => void> = [];
let activeImports = 0;
const importWaiters: Array<() => void> = [];

async function acquireCodecSlot(): Promise<() => void> {
  if (activeCodecs >= MAX_CONCURRENT_CODECS) {
    await new Promise<void>((resolve) => codecWaiters.push(resolve));
  }
  activeCodecs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCodecs -= 1;
    codecWaiters.shift()?.();
  };
}

async function acquireImportSlot(): Promise<() => void> {
  if (activeImports >= MAX_CONCURRENT_IMPORTS) {
    await new Promise<void>((resolve) => importWaiters.push(resolve));
  }
  activeImports += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeImports -= 1;
    importWaiters.shift()?.();
  };
}

/**
 * Hold import admission for the complete parse-and-commit lifecycle. Codec
 * workers have their own narrower admission because exports also use them.
 */
export async function withAgentImportAdmission<T>(
  work: () => Promise<T>,
): Promise<T> {
  const release = await acquireImportSlot();
  try {
    return await work();
  } finally {
    release();
  }
}

function workerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../dist/agent-package-codec-worker.js", import.meta.url)
    : new URL("./agent-package-codec-worker.js", import.meta.url);
}

async function runCodecWorker<T>(
  workerData: object,
  transferList: ArrayBuffer[] = [],
): Promise<T> {
  const release = await acquireCodecSlot();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl(), {
        workerData,
        transferList,
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
        },
      });
    } catch (error) {
      release();
      reject(error);
      return;
    }
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: T & { error?: string }): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      worker.removeAllListeners();
      void worker.terminate();
      release();
      if (outcome.error) reject(new Error(outcome.error));
      else resolve(outcome);
    };
    timeout = setTimeout(() => finish({
      error: "Agent package codec exceeded its 60 second processing budget",
    } as T & { error: string }), CODEC_TIMEOUT_MS);
    timeout.unref?.();
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

export async function parsePortablePackageFile(
  pathname: string,
): Promise<{
  metadata: Omit<ImportAgentPackageRequest, "package">;
  portable: AgentPortablePackageDto;
}> {
  const result = await runCodecWorker<{
    metadata: Omit<ImportAgentPackageRequest, "package">;
    portableBytes: ArrayBuffer;
  }>({
    operation: "parse-file",
    pathname,
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    metadata: result.metadata,
    portable: JSON.parse(
      decoder.decode(new Uint8Array(result.portableBytes)),
    ) as AgentPortablePackageDto,
  };
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
