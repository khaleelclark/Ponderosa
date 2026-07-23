import { gzipSync } from "node:zlib";

export interface ArchiveEntry {
  name: string;
  content: Buffer | string;
  modifiedAt?: Date;
}

function octal(value: number, length: number): Buffer {
  const output = Buffer.alloc(length, 0);
  const encoded = value.toString(8).padStart(length - 1, "0");
  output.write(encoded.slice(-(length - 1)), 0, "ascii");
  return output;
}

function tarHeader(name: string, size: number, modifiedAt: Date): Buffer {
  const safeName = name.replace(/^\/+|\.\.(?:\/|\\)/g, "").replaceAll("\\", "/");
  if (!safeName || Buffer.byteLength(safeName) > 100) {
    throw new Error(`diagnostic archive path is invalid or too long: ${name}`);
  }
  const header = Buffer.alloc(512, 0);
  header.write(safeName, 0, 100, "utf8");
  octal(0o600, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(Math.floor(modifiedAt.getTime() / 1_000), 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("Ponderosa", 265, 32, "ascii");
  header.write("Ponderosa", 297, 32, "ascii");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function createTarGz(entries: ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    chunks.push(tarHeader(entry.name, content.length, entry.modifiedAt ?? new Date()), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}
