import path from "node:path";
import type { ArtifactContentDto } from "@ponderosa/core";

function acceptsGzip(value: string | string[] | undefined): boolean {
  const preferences = String(value ?? "").split(",").map((entry) => {
    const [encoding, ...parameters] = entry.trim().toLowerCase().split(";");
    const quality = parameters.map((parameter) => /^q\s*=\s*([0-9.]+)$/.exec(parameter.trim())?.[1])
      .find((candidate) => candidate !== undefined);
    return { encoding, quality: quality === undefined ? 1 : Number(quality) };
  });
  const explicit = preferences.find((preference) => preference.encoding === "gzip");
  if (explicit) return explicit.quality > 0;
  return Boolean(preferences.find((preference) => preference.encoding === "*" && preference.quality > 0));
}

function utf8Page(content: string, start: number, maximum: number): {
  output: string;
  pageUtf8Bytes: number;
  endUtf8Byte: number;
  totalUtf8Bytes: number;
} {
  const bytes = Buffer.from(content, "utf8");
  if (start > bytes.length || (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)) {
    throw new Error("activity output cursor is not on a UTF-8 boundary");
  }
  let end = Math.min(bytes.length, start + maximum);
  while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const output = bytes.subarray(start, end).toString("utf8");
  return { output, pageUtf8Bytes: end - start, endUtf8Byte: end, totalUtf8Bytes: bytes.length };
}

function utf8PageEnd(content: Buffer, start: number, maximumEnd: number): number {
  let end = Math.min(content.length, maximumEnd);
  if (end >= content.length) return end;
  while (end > start && (content[end]! & 0xc0) === 0x80) end -= 1;
  return end > start ? end : Math.min(content.length, maximumEnd);
}

/** Return one bounded, code-point-aligned UTF-8 prefix. Validation decodes the
 * prefix exactly once; malformed content fails into the caller's binary path. */
function boundedUtf8Preview(content: Buffer, maximumBytes: number): Buffer | undefined {
  let end = Math.min(content.length, maximumBytes);
  if (end < content.length && end > 0) {
    let lead = end - 1;
    while (lead >= Math.max(0, end - 4) && (content[lead]! & 0xc0) === 0x80) lead -= 1;
    if (lead < 0) end = 0;
    else {
      const byte = content[lead]!;
      const expectedBytes = byte < 0x80 ? 1
        : (byte & 0xe0) === 0xc0 ? 2
          : (byte & 0xf0) === 0xe0 ? 3
            : (byte & 0xf8) === 0xf0 ? 4
              : 1;
      if (lead + expectedBytes > end) end = lead;
    }
  }
  const candidate = content.subarray(0, end);
  try {
    return Buffer.from(new TextDecoder("utf-8", { fatal: true }).decode(candidate), "utf8");
  } catch {
    return undefined;
  }
}

function contentTypeForStatic(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json") || file.endsWith(".webmanifest")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".pdf")) return "application/pdf";
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".woff")) return "font/woff";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function cacheControlForStatic(file: string): string {
  const base = path.basename(file);
  if (base === "index.html" || base === "sw.js" || base === "register-sw.js" || base === "manifest.webmanifest") return "no-cache";
  if (file.includes(`${path.sep}static${path.sep}`)) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

function contentTypeForArtifact(file: string): ArtifactContentDto["contentType"] {
  if (file.endsWith(".md")) return "markdown";
  if (file.endsWith(".patch") || file.endsWith(".diff")) return "diff";
  return "text";
}

export {
  acceptsGzip,
  utf8Page,
  utf8PageEnd,
  boundedUtf8Preview,
  contentTypeForStatic,
  cacheControlForStatic,
  contentTypeForArtifact,
};
