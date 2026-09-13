import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

interface HeifImage {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  display(image: { width: number; height: number; data: Uint8ClampedArray }, callback: (result: unknown) => void): void;
  free(): void;
}

// The packaged WASM decoder avoids installing host-wide codec libraries.
const heif = await createRequire(import.meta.url)("libheif-js/wasm-bundle");
const images: HeifImage[] = new heif.HeifDecoder().decode(workerData.body);
try {
  const image = images.find(item => item.is_primary()) ?? (images.length === 1 ? images[0] : undefined);
  if (!image) throw new Error("HEIC has no primary still image");
  const width = image.get_width();
  const height = image.get_height();
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > workerData.maxPixels) {
    throw new Error("HEIC exceeds image dimensions limit");
  }
  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => image.display({ width, height, data }, result => {
    if (result) resolve(); else reject(new Error("HEIC pixels could not be decoded"));
  }));
  parentPort!.postMessage({ width, height, data: new Uint8Array(data.buffer) }, [data.buffer]);
} finally {
  for (const image of images) image.free();
}
