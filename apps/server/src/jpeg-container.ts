/** Find the real JPEG end marker, not an FF D9 inside a segment or metadata. */
function jpegEnd(body: Buffer): number | undefined {
  if (body[0] !== 0xff || body[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < body.length) {
    if (body[offset++] !== 0xff) return undefined;
    while (body[offset] === 0xff) offset += 1;
    const marker = body[offset++];
    if (marker === 0xd9) return offset;
    if (marker === undefined || marker === 0 || marker === 0xd8) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > body.length) return undefined;
    const length = body.readUInt16BE(offset);
    if (length < 2 || offset + length > body.length) return undefined;
    offset += length;
    if (marker !== 0xda) continue;
    // Entropy-coded scans escape FF as FF 00 and contain restart markers.
    while (offset < body.length) {
      const next = body.indexOf(0xff, offset);
      if (next < 0) return undefined;
      offset = next + 1;
      while (body[offset] === 0xff) offset += 1;
      const code = body[offset];
      if (code === 0 || (code !== undefined && code >= 0xd0 && code <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset = next;
      break;
    }
  }
  return undefined;
}

function capturedAppInfo(value: Buffer): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  const encoded = value.toString("latin1");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) return false;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return false;
  try {
    const info: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    return typeof info === "object" && info !== null && !Array.isArray(info)
      && Object.keys(info).length === 1 && "comp" in info
      && typeof info.comp === "string" && info.comp.length > 0 && info.comp.length <= 1024
      && !/[\u0000-\u001f\u007f]/u.test(info.comp);
  } catch { return false; }
}

/**
 * Samsung screenshots append SEF capture metadata after JPEG EOI. Recognize the
 * observed v107 layout without treating arbitrary trailing bytes as an image.
 * ponytail: only the two screenshot fields, at most 8 KiB; new SEF fields/versions
 * or Motion Photos require separately qualified support, not a generic bypass.
 */
export function hasSamsungScreenshotTrailer(body: Buffer): boolean {
  if (body.length < 36 || body.subarray(-4).toString("latin1") !== "SEFT") return false;
  const directoryLength = body.readUInt32LE(body.length - 8);
  if (directoryLength < 24 || directoryLength > 36) return false;
  const directory = body.length - 8 - directoryLength;
  if (directory < 4 || body.subarray(directory, directory + 4).toString("latin1") !== "SEFH"
      || body.readUInt32LE(directory + 4) !== 107) return false;
  const count = body.readUInt32LE(directory + 8);
  if (count < 1 || count > 2 || directoryLength !== 12 + 12 * count) return false;

  const blocks: Array<{ start: number; end: number }> = [];
  const types = new Set<number>();
  let capture = false;
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 12 + index * 12;
    const type = body.readUInt16LE(entry + 2);
    const back = body.readUInt32LE(entry + 4);
    const size = body.readUInt32LE(entry + 8);
    const start = directory - back;
    const end = start + size;
    if (body.readUInt16LE(entry) !== 0 || types.has(type) || start < 4
        || body.length - start > 8192 || size < 8 || end > directory
        || !body.subarray(start, start + 4).equals(body.subarray(entry, entry + 4))) return false;
    types.add(type);
    const nameLength = body.readUInt32LE(start + 4);
    if (nameLength > size - 8) return false;
    const name = body.subarray(start + 8, start + 8 + nameLength);
    const value = body.subarray(start + 8 + nameLength, end);
    if (type === 0x0c51 && name.equals(Buffer.from("Samsung_Capture_Info"))
        && value.equals(Buffer.from("Screenshot"))) capture = true;
    else if (!(type === 0x0da1 && name.equals(Buffer.from("Captured_App_Info"))
        && capturedAppInfo(value))) return false;
    blocks.push({ start, end });
  }
  if (!capture) return false;
  blocks.sort((left, right) => left.start - right.start);
  let end = jpegEnd(body);
  if (end === undefined) return false;
  for (const block of blocks) {
    if (block.start !== end) return false;
    end = block.end;
  }
  return end === directory;
}
