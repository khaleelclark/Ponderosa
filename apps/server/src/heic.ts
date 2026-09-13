import { Worker } from "node:worker_threads";
import { AssetError } from "./asset-contracts.js";

/** Admit only a complete ISO-BMFF still-image container advertising HEVC. */
export function isHeicContainer(body: Buffer): boolean {
  if (body.length < 24 || body.toString("ascii", 4, 8) !== "ftyp") return false;
  const ftypSize = body.readUInt32BE(0);
  if (ftypSize < 16 || ftypSize > 4096 || ftypSize > body.length || ftypSize % 4 !== 0) return false;
  const brands = [body.toString("ascii", 8, 12)];
  for (let offset = 16; offset < ftypSize; offset += 4) brands.push(body.toString("ascii", offset, offset + 4));
  if (!brands.some(brand => brand === "heic" || brand === "heix") || brands.includes("msf1")) return false;
  let offset = 0;
  while (offset < body.length) {
    if (body.length - offset < 8) return false;
    let size = body.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (body.length - offset < 16) return false;
      const extended = body.readBigUInt64BE(offset + 8);
      if (extended > BigInt(body.length - offset)) return false;
      size = Number(extended);
      header = 16;
    } else if (size === 0) size = body.length - offset;
    if (size < header || size > body.length - offset) return false;
    offset += size;
  }
  return offset === body.length;
}

let activeDecoders = 0;
const waitingDecoders: Array<() => void> = [];

/** Each decode gets a fresh WASM heap; never run synchronous HEVC on the server thread. */
export async function decodeHeic(body: Buffer, maxPixels: number): Promise<{
  width: number; height: number; data: Uint8Array;
}> {
  if (activeDecoders < 2) activeDecoders += 1;
  else {
    if (waitingDecoders.length >= 18) throw new AssetError(429, "Photo conversion is busy. Please retry this attachment.");
    await new Promise<void>(resolve => waitingDecoders.push(resolve));
  }
  let worker: Worker | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL("./heic-worker.js", import.meta.url), {
      workerData: { body, maxPixels },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      stdout: true, stderr: true,
    });
    // Decoder diagnostics must not expose uploaded bytes or flood server logs.
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("HEIC decode timed out")), 15_000);
      worker!.once("message", resolve);
      worker!.once("error", reject);
      worker!.once("exit", () => reject(new Error("HEIC decoder exited without an image")));
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    await worker?.terminate();
    const next = waitingDecoders.shift();
    if (next) next(); else activeDecoders -= 1;
  }
}
