import { DOMParser, type Element } from "@xmldom/xmldom";
import { validMotionVideo } from "./image-containers.js";

/** Find the real JPEG end marker, not an FF D9 inside a segment or metadata. */
export function jpegEnd(body: Buffer): number | undefined {
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

export function pngEnd(body: Buffer): number | undefined {
  if (!body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return undefined;
  let offset = 8;
  while (offset + 12 <= body.length) {
    const length = body.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > body.length) return undefined;
    const type = body.subarray(offset + 4, offset + 8).toString("latin1");
    if (type === "IEND") return length === 0 ? end : undefined;
    offset = end;
  }
  return undefined;
}

const CAMERA = "http://ns.google.com/photos/1.0/camera/";
const CONTAINER = "http://ns.google.com/photos/1.0/container/";
const ITEM = "http://ns.google.com/photos/1.0/container/item/";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

function property(root: Element, namespace: string, name: string): string | undefined {
  const values: string[] = [];
  for (const element of [root, ...Array.from(root.getElementsByTagName("*"))]) {
    const attribute = element.getAttributeNodeNS(namespace, name);
    if (attribute) values.push(attribute.value);
    if (element.namespaceURI === namespace && element.localName === name) values.push(element.textContent ?? "");
  }
  return values.length === 1 ? values[0] : undefined;
}

/** Qualified two-resource XMP Motion Photos; no regex matching of XML prefixes. */
export function hasXmpMotionPhoto(body: Buffer): boolean {
  const end = jpegEnd(body);
  if (end === undefined || end === body.length) return false;
  const prefix = Buffer.from("http://ns.adobe.com/xap/1.0/\0");
  let offset = 2;
  let xmp: Buffer | undefined;
  while (offset + 4 <= end) {
    if (body[offset++] !== 0xff) return false;
    while (body[offset] === 0xff) offset++;
    const marker = body[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
    const size = body.readUInt16BE(offset);
    if (size < 2 || offset + size > end) return false;
    const payload = body.subarray(offset + 2, offset + size);
    if (marker === 0xe1 && payload.subarray(0, prefix.length).equals(prefix)) {
      if (xmp) return false;
      xmp = payload.subarray(prefix.length);
    }
    offset += size;
  }
  if (!xmp) return false;
  try {
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(xmp);
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return false;
    const document = new DOMParser({ onError: () => { throw new Error("invalid Motion Photo XMP"); } }).parseFromString(xml, "application/xml");
    const root = document.documentElement;
    if (!root) return false;
    let videoLength: number;
    let padding = 0;
    if (property(root, CAMERA, "MotionPhoto") === "1" && property(root, CAMERA, "MotionPhotoVersion") === "1") {
      const directories = root.getElementsByTagNameNS(CONTAINER, "Directory");
      if (directories.length !== 1) return false;
      const sequences = directories[0]!.getElementsByTagNameNS(RDF, "Seq");
      if (sequences.length !== 1) return false;
      const entries = sequences[0]!.getElementsByTagNameNS(RDF, "li");
      // ponytail: primary JPEG + one video only. Gain-map/extended-XMP variants
      // need separate fixtures before widening this admission boundary.
      if (entries.length !== 2 || property(entries[0]!, ITEM, "Semantic") !== "Primary"
          || property(entries[0]!, ITEM, "Mime") !== "image/jpeg"
          || ![undefined, "0"].includes(property(entries[0]!, ITEM, "Length"))
          || property(entries[1]!, ITEM, "Semantic") !== "MotionPhoto"
          || !["video/mp4", "video/quicktime"].includes(property(entries[1]!, ITEM, "Mime") ?? "")
          || property(entries[1]!, ITEM, "Padding") !== undefined) return false;
      const length = property(entries[1]!, ITEM, "Length");
      const pad = property(entries[0]!, ITEM, "Padding") ?? "0";
      if (!length || !/^[1-9][0-9]{0,8}$/u.test(length) || !/^(?:0|[1-9][0-9]{0,3})$/u.test(pad)) return false;
      videoLength = Number(length); padding = Number(pad);
    } else if (property(root, CAMERA, "MicroVideo") === "1"
        && property(root, CAMERA, "MicroVideoVersion") === "1") {
      const length = property(root, CAMERA, "MicroVideoOffset");
      if (!length || !/^[1-9][0-9]{0,8}$/u.test(length)) return false;
      videoLength = Number(length);
    } else return false;
    return padding <= 1024 && end + padding + videoLength === body.length
      && body.subarray(end, end + padding).every(byte => byte === 0)
      && validMotionVideo(body.subarray(end + padding));
  } catch { return false; }
}

function capturedAppInfo(value: Buffer): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  const encoded = value.toString("latin1");
  // Samsung uses either a plain app package or base64-encoded component JSON.
  // Match the complete ASCII package: `$` alone also accepts a final newline.
  const packageName = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.exec(encoded)?.[0];
  if (value.length <= 1024 && packageName?.length === value.length) return true;
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
 * Retain the screenshot-only entry point and its original two-field/8KiB bounds.
 * The shared parser additionally admits qualified Motion Photo fields when the
 * caller opts in; unrecognized fields and SEF versions remain rejected.
 */
export function hasSamsungScreenshotTrailer(body: Buffer): boolean {
  return hasSamsungImageTrailer(body, false);
}

export function hasSamsungImageTrailer(body: Buffer, allowMotion = true): boolean {
  if (body.length < 36 || body.subarray(-4).toString("latin1") !== "SEFT") return false;
  const directoryLength = body.readUInt32LE(body.length - 8);
  if (directoryLength < 24 || directoryLength > (allowMotion ? 84 : 36)) return false;
  const directory = body.length - 8 - directoryLength;
  if (directory < 4 || body.subarray(directory, directory + 4).toString("latin1") !== "SEFH"
      || body.readUInt32LE(directory + 4) !== 107) return false;
  const count = body.readUInt32LE(directory + 8);
  if (count < 1 || count > (allowMotion ? 6 : 2) || directoryLength !== 12 + 12 * count) return false;

  const blocks: Array<{ start: number; end: number }> = [];
  const types = new Set<number>();
  let capture = false;
  let motion = false;
  let videoReference: { start: number; end: number } | undefined;
  let metadataBytes = directoryLength + 8;
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 12 + index * 12;
    const type = body.readUInt16LE(entry + 2);
    const back = body.readUInt32LE(entry + 4);
    const size = body.readUInt32LE(entry + 8);
    const start = directory - back;
    const end = start + size;
    if (body.readUInt16LE(entry) !== 0 || types.has(type) || start < 4
        || (!allowMotion && body.length - start > 8192) || size < 8 || end > directory
        || !body.subarray(start, start + 4).equals(body.subarray(entry, entry + 4))) return false;
    types.add(type);
    const nameLength = body.readUInt32LE(start + 4);
    if (nameLength > 64 || nameLength > size - 8) return false;
    const name = body.subarray(start + 8, start + 8 + nameLength);
    const value = body.subarray(start + 8 + nameLength, end);
    if (type === 0x0c51 && name.equals(Buffer.from("Samsung_Capture_Info"))
        && value.equals(Buffer.from("Screenshot"))) capture = true;
    else if (type === 0x0da1 && name.equals(Buffer.from("Captured_App_Info")) && capturedAppInfo(value)) { /* qualified screenshot metadata */ }
    else if (allowMotion && type === 0x0a30 && name.equals(Buffer.from("MotionPhoto_Data"))) {
      if (value.length === 12 && value.subarray(0, 4).equals(Buffer.from("mpv2"))) {
        const videoStart = value.readUInt32BE(4);
        const videoEnd = videoStart + value.readUInt32BE(8);
        if (videoStart < 4 || videoEnd > start || !validMotionVideo(body.subarray(videoStart, videoEnd))) return false;
        videoReference = { start: videoStart, end: videoEnd };
      } else if (!validMotionVideo(value)) return false;
      motion = true;
    } else if (allowMotion && type === 0x0a33 && name.equals(Buffer.from("MotionPhoto_AutoPlay")) && validMotionVideo(value)) { /* optional autoplay copy */ }
    else if (allowMotion && type === 0x0a31 && name.equals(Buffer.from("MotionPhoto_Version"))
        && ((value.length === 4 && value.readUInt32LE(0) >= 1 && value.readUInt32LE(0) <= 4)
          || /^[1-4]$/u.test(value.toString("latin1")) && value.length === 1)) { /* bounded version */ }
    else if (allowMotion && type === 0x0a01 && name.equals(Buffer.from("Image_UTC_Data"))
        && value.length === 13 && /^[0-9]{13}$/u.test(value.toString("latin1"))) { /* timestamp */ }
    else return false;
    metadataBytes += type === 0x0a30 || type === 0x0a33 ? 8 + nameLength + (value.length === 12 ? 12 : 0) : size;
    if (metadataBytes > (allowMotion ? 16384 : 8192)) return false;
    blocks.push({ start, end });
  }
  if ((!capture && !motion) || (!motion && [0x0a31, 0x0a33, 0x0a01].some(type => types.has(type)))) return false;
  if (!motion && (count > 2 || metadataBytes > 8192)) return false;
  blocks.sort((left, right) => left.start - right.start);
  let end = jpegEnd(body) ?? pngEnd(body);
  if (end === undefined) return false;
  if (videoReference) {
    if (videoReference.start !== end) return false;
    end = videoReference.end;
  }
  for (const block of blocks) {
    if (block.start !== end) return false;
    end = block.end;
  }
  return end === directory;
}
