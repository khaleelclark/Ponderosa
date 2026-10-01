// Shared container validation; profile-image callers retain their 4,096px limit.
function skipGifSubBlocks(body: Buffer, initialOffset: number): number | undefined {
  let offset = initialOffset;
  while (offset < body.length) {
    const length = body[offset++]!;
    if (length === 0) return offset;
    if (offset + length > body.length) return undefined;
    offset += length;
  }
  return undefined;
}

export function validGif(body: Buffer, maxDimension = 4_096, maxFrames = Infinity): boolean {
  if (body.length < 14 || !["GIF87a", "GIF89a"].includes(body.subarray(0, 6).toString("latin1"))) return false;
  const width = body.readUInt16LE(6);
  const height = body.readUInt16LE(8);
  if (width === 0 || height === 0 || width > maxDimension || height > maxDimension) return false;
  const packed = body[10]!;
  let offset = 13 + ((packed & 0x80) ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  let sawImage = false;
  let frames = 0;
  let blocks = 0;
  while (offset < body.length) {
    if (++blocks > maxFrames * 8) return false;
    const introducer = body[offset++]!;
    if (introducer === 0x3b) return sawImage && offset === body.length;
    if (introducer === 0x21) {
      if (offset >= body.length) return false;
      offset += 1;
      const end = skipGifSubBlocks(body, offset);
      if (end === undefined) return false;
      offset = end;
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > body.length) return false;
    if (++frames > maxFrames) return false;
    const imageWidth = body.readUInt16LE(offset + 4);
    const imageHeight = body.readUInt16LE(offset + 6);
    if (imageWidth === 0 || imageHeight === 0 || imageWidth > maxDimension || imageHeight > maxDimension) return false;
    if (body.readUInt16LE(offset) + imageWidth > width || body.readUInt16LE(offset + 2) + imageHeight > height) return false;
    const descriptorPacked = body[offset + 8]!;
    offset += 9 + ((descriptorPacked & 0x80) ? 3 * 2 ** ((descriptorPacked & 0x07) + 1) : 0);
    if (offset >= body.length || body[offset]! < 2 || body[offset]! > 8) return false;
    const end = skipGifSubBlocks(body, offset + 1);
    if (end === undefined) return false;
    offset = end;
    sawImage = true;
  }
  return false;
}

export function validAvif(body: Buffer, maxBoxes = Infinity): boolean {
  if (body.length < 32) return false;
  let offset = 0;
  let sawFtyp = false;
  let avifBrand = false;
  let sawMeta = false;
  let sawMediaData = false;
  let boxes = 0;
  while (offset + 8 <= body.length) {
    if (++boxes > maxBoxes) return false;
    const size32 = body.readUInt32BE(offset);
    const type = body.subarray(offset + 4, offset + 8).toString("latin1");
    if (!/^[\x20-\x7e]{4}$/u.test(type)) return false;
    let header = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > body.length) return false;
      const wide = body.readBigUInt64BE(offset + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(wide);
      header = 16;
    }
    if (size < header || size === 0 || offset + size > body.length) return false;
    if (offset === 0) {
      if (type !== "ftyp" || size < header + 8) return false;
      sawFtyp = true;
      const brands = [body.subarray(offset + header, offset + header + 4).toString("latin1")];
      for (let brand = offset + header + 8; brand + 4 <= offset + size; brand += 4) brands.push(body.subarray(brand, brand + 4).toString("latin1"));
      avifBrand = brands.some((brand) => brand === "avif" || brand === "avis");
    }
    if (type === "meta") {
      if (size < header + 4) return false;
      sawMeta = true;
    }
    if (type === "mdat") {
      if (size === header) return false;
      sawMediaData = true;
    }
    offset += size;
  }
  return offset === body.length && sawFtyp && avifBrand && sawMeta && sawMediaData;
}

/** Validate a complete embedded MP4/QuickTime container without decoding video. */
export function validMotionVideo(body: Buffer): boolean {
  let boxes = 0;
  let video = false;
  let media = false;
  let movie = false;
  let brand = false;
  const walk = (start: number, end: number, depth: number): boolean => {
    let offset = start;
    while (offset + 8 <= end) {
      if (++boxes > 4096) return false;
      const small = body.readUInt32BE(offset);
      let size = small;
      let header = 8;
      if (small === 1) {
        if (offset + 16 > end) return false;
        const wide = body.readBigUInt64BE(offset + 8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        size = Number(wide); header = 16;
      }
      const type = body.subarray(offset + 4, offset + 8).toString("latin1");
      if (!/^[\x20-\x7e]{4}$/u.test(type) || size < header || offset + size > end) return false;
      const content = offset + header;
      if (depth === 0) {
        if (type === "ftyp" && offset !== 0) return false;
        if (offset === 0) {
          if (type !== "ftyp" || size < header + 8 || (size - header) % 4 !== 0) return false;
          for (let index = content; index + 4 <= offset + size; index += 4) {
            if (index === content + 4) continue; // minor version, not a brand
            if (["isom", "iso2", "mp41", "mp42", "avc1", "qt  "].includes(body.subarray(index, index + 4).toString("latin1"))) brand = true;
          }
        }
        if (type === "mdat" && size > header) media = true;
        if (type === "moov") {
          if (movie || size > 4 * 1024 * 1024) return false;
          movie = true;
        }
      }
      if ((depth === 0 && type === "moov") || (depth === 1 && type === "trak") || (depth === 2 && type === "mdia")) {
        if (!walk(content, offset + size, depth + 1)) return false;
      }
      if (depth === 3 && type === "hdlr" && size >= header + 24
          && body.subarray(content + 8, content + 12).toString("latin1") === "vide") video = true;
      offset += size;
    }
    return offset === end;
  };
  return body.length >= 32 && walk(0, body.length, 0) && brand && movie && media && video;
}
