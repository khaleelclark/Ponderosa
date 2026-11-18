import {gunzipSync} from 'node:zlib';
import type {PortableArtifactDto} from '@ponderosa/core';
import {MANAGED_ARTIFACT_MAX_BYTES} from './managed-artifact-files.js';
type ArtifactData=Pick<PortableArtifactDto,'dataBase64'|'dataEncoding'|'decodedSize'>;

/** Shared bounded original decoding for import reviews and synchronous custody checks. */
export function portableBase64ByteLength(dataBase64: string): number {
  if (dataBase64.length > Math.ceil(MANAGED_ARTIFACT_MAX_BYTES / 3) * 4) throw new Error("portable artifact exceeds the 64 MiB managed-file limit");
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  const length = dataBase64.length - padding;
  const bytes = Math.floor(length * 3 / 4);
  if (bytes > MANAGED_ARTIFACT_MAX_BYTES) throw new Error("portable artifact exceeds the 64 MiB managed-file limit");
  if (length % 4 === 1 || (padding && dataBase64.length % 4 !== 0)) throw new Error("portable artifact has invalid base64 data");
  for (let offset=0; offset<length; offset+=256*1024) {
    if (/[^A-Za-z0-9+/]/u.test(dataBase64.slice(offset,Math.min(length,offset+256*1024)))) throw new Error("portable artifact has invalid base64 data");
  }
  const tail=dataBase64.slice(length ? Math.floor((length-1)/4)*4 : 0,length);
  if (Buffer.from(tail,"base64").toString("base64").replace(/=+$/u,"") !== tail) throw new Error("portable artifact has invalid base64 data");
  return bytes;
}


export function portableArtifactByteLength(artifact: ArtifactData): number {
  const encodedBytes = portableBase64ByteLength(artifact.dataBase64);
  if (artifact.dataEncoding === undefined) {
    if (artifact.decodedSize !== undefined) throw new Error("Unencoded artifact cannot declare a decoded size");
    return encodedBytes;
  }
  if (artifact.dataEncoding !== "gzip" || !Number.isSafeInteger(artifact.decodedSize)
      || artifact.decodedSize! < 0 || artifact.decodedSize! > MANAGED_ARTIFACT_MAX_BYTES) {
    throw new Error("Invalid portable artifact encoding or decoded size (64 MiB per file)");
  }
  return artifact.decodedSize!;
}

export function decodePortableMetadataArtifact(artifact: ArtifactData, maximumBytes = 48 * 1024 * 1024): Buffer {
  const expected = portableArtifactByteLength(artifact);
  if (expected > maximumBytes) throw new Error("Reviewed user-data original exceeds " + maximumBytes / (1024 * 1024) + " MiB");
  let data = Buffer.from(artifact.dataBase64, "base64");
  if (artifact.dataEncoding === "gzip") {
    try { data = gunzipSync(data, { maxOutputLength: Math.max(1, expected) }); }
    catch { throw new Error("Reviewed user-data gzip is corrupt or exceeds its declared original size"); }
  }
  if (data.length !== expected) throw new Error("Reviewed user-data original size differs");
  return data;
}
