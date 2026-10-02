import { noteBackgroundRateLimit } from "../../api/backgroundCooldown.js";

export const DOCX_PREVIEW_LIMITS = { fileBytes: 80 * 1024 * 1024, xmlBytes: 2 * 1024 * 1024,
  entries: 10_000, xmlElements: 20_000, paragraphs: 1000, characters: 100_000 } as const;
const invalid = () => new Error("This Word document is damaged or uses an unsupported format. Download it to open it in Word.");
const tooLarge = () => new Error("This Word document is too large to preview safely. Download it to view the complete document.");

async function boundedBytes(stream: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const cancel = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { signal.removeEventListener("abort", cancel); await cancel(); reader.releaseLock(); }
}

/** Fetch only the already-authorized attachment/file route; no external viewer. */
export async function readDocxPreview(url: string, signal: AbortSignal): Promise<string> {
  const target = new URL(url, window.location.origin);
  if (target.origin !== window.location.origin || !target.pathname.startsWith("/api/")) throw new Error("Invalid Word document preview URL");
  const response = await fetch(target.href, { signal, credentials: "same-origin", cache: "no-store", redirect: "error" });
  if (response.status === 429) noteBackgroundRateLimit(response.headers.get("Retry-After"));
  if (!response.ok) throw new Error(`Word document could not be loaded (${response.status}). Try again or download the file.`);
  if (Number(response.headers.get("Content-Length")) > DOCX_PREVIEW_LIMITS.fileBytes) { await response.body?.cancel(); throw tooLarge(); }
  if (!response.body) throw new Error("The Word document response is empty");
  return readDocxDocumentXml(await boundedBytes(response.body, DOCX_PREVIEW_LIMITS.fileBytes, signal), signal);
}

/** Read only word/document.xml, never unpack paths, relationships or media. */
export async function readDocxDocumentXml(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (bytes.length > DOCX_PREVIEW_LIMITS.fileBytes) throw tooLarge();
  if (bytes.length < 22) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) throw invalid();
  const entries = view.getUint16(end + 10, true), directoryBytes = view.getUint32(end + 12, true), directory = view.getUint32(end + 16, true);
  if (entries > DOCX_PREVIEW_LIMITS.entries || directoryBytes > 4 * 1024 * 1024) throw tooLarge();
  if (entries !== view.getUint16(end + 8, true) || directory + directoryBytes !== end) throw invalid();
  let found: { offset: number; method: number; compressed: number; size: number; crc: number } | undefined;
  let offset = directory;
  for (let index = 0; index < entries; index++) {
    signal.throwIfAborted();
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalid();
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > end) throw invalid();
    const name = nameLength === 17 ? new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)) : "";
    if (name === "word/document.xml") {
      if (found || view.getUint16(offset + 8, true) & 1 || view.getUint16(offset + 34, true) !== 0) throw invalid();
      found = { offset: view.getUint32(offset + 42, true), method: view.getUint16(offset + 10, true),
        compressed: view.getUint32(offset + 20, true), size: view.getUint32(offset + 24, true), crc: view.getUint32(offset + 16, true) };
    }
    offset = next;
  }
  if (offset !== end || !found || ![0, 8].includes(found.method)) throw invalid();
  if (found.size > DOCX_PREVIEW_LIMITS.xmlBytes || found.compressed > DOCX_PREVIEW_LIMITS.xmlBytes) throw tooLarge();
  const local = found.offset;
  if (local + 30 > directory || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) & 1 || view.getUint16(local + 8, true) !== found.method) throw invalid();
  const nameLength = view.getUint16(local + 26, true), start = local + 30 + nameLength + view.getUint16(local + 28, true);
  if (start + found.compressed > directory || new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + nameLength)) !== "word/document.xml") throw invalid();
  const content = bytes.subarray(start, start + found.compressed);
  let xml: Uint8Array = content;
  if (found.method === 8) {
    // Small compressed input chunks also bound native inflater amplification.
    let position = 0;
    const compressed = new ReadableStream<BufferSource>({ pull(controller) {
      if (position >= content.length) { controller.close(); return; }
      controller.enqueue(new Uint8Array(content.subarray(position, position + 1024))); position += 1024;
    } });
    let inflater: DecompressionStream;
    try { inflater = new DecompressionStream("deflate-raw"); }
    catch { throw new Error("This browser cannot preview compressed Word documents. Download the file to open it in Word."); }
    try { xml = await boundedBytes(compressed.pipeThrough(inflater, { signal }), DOCX_PREVIEW_LIMITS.xmlBytes, signal); }
    catch (error) { signal.throwIfAborted(); if (error instanceof Error && error.message === tooLarge().message) throw error; throw invalid(); }
  }
  signal.throwIfAborted();
  if (xml.length !== found.size || crc32(xml) !== found.crc) throw invalid();
  const encoding = xml[0] === 0xff && xml[1] === 0xfe ? "utf-16le" : xml[0] === 0xfe && xml[1] === 0xff ? "utf-16be" : "utf-8";
  try { return new TextDecoder(encoding, { fatal: true }).decode(xml); }
  catch { throw invalid(); }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface DocxParagraph { text: string; heading?: number }

/** XML stays detached. Only Word text becomes React strings, never HTML.
 * ponytail: text-only, bounded 2 MiB XML; full Word layout needs a separately
 * qualified renderer, not a larger parsing limit or injected document HTML. */
export function docxParagraphs(xml: string, signal: AbortSignal): { paragraphs: DocxParagraph[]; truncated: boolean } {
  signal.throwIfAborted();
  if (xml.length > DOCX_PREVIEW_LIMITS.xmlBytes || /<!\s*(DOCTYPE|ENTITY)/iu.test(xml)) throw invalid();
  let elements = 0;
  for (const char of xml) if (char === "<" && ++elements > DOCX_PREVIEW_LIMITS.xmlElements) throw tooLarge();
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const root = document.documentElement, namespace = root.namespaceURI ?? "";
  if (document.getElementsByTagName("parsererror").length || root.localName !== "document" ||
      !["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"].includes(namespace)) throw invalid();
  const body = Array.from(root.children).find(element => element.localName === "body" && element.namespaceURI === namespace);
  if (!body) throw invalid();
  const paragraphs: DocxParagraph[] = [];
  let characters = 0, truncated = false;
  const candidates = body.getElementsByTagNameNS(namespace, "p");
  for (const paragraph of Array.from(candidates)) {
    signal.throwIfAborted();
    if (paragraphs.length >= DOCX_PREVIEW_LIMITS.paragraphs || characters >= DOCX_PREVIEW_LIMITS.characters) { truncated = true; break; }
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT, { acceptNode(node) {
      const element = node as Element;
      // Text boxes may contain nested paragraphs. Visit each only once.
      return element.namespaceURI === namespace && element.localName === "p" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    } });
    let text = "";
    while (walker.nextNode()) {
      const element = walker.currentNode as Element;
      if (element.namespaceURI !== namespace) continue;
      if (element.localName === "t" && element.childElementCount) throw invalid();
      const value = element.localName === "t" ? element.textContent ?? "" : element.localName === "tab" ? "\t" : ["br", "cr"].includes(element.localName) ? "\n" : "";
      const remaining = DOCX_PREVIEW_LIMITS.characters - characters - text.length;
      if (value.length > remaining) { text += value.slice(0, remaining).replace(/[\uD800-\uDBFF]$/u, ""); truncated = true; break; }
      text += value;
    }
    characters += text.length;
    const properties = Array.from(paragraph.children).find(element => element.namespaceURI === namespace && element.localName === "pPr");
    const style = Array.from(properties?.children ?? []).find(element => element.namespaceURI === namespace && element.localName === "pStyle")?.getAttributeNS(namespace, "val");
    const heading = /^heading([1-6])$/iu.exec(style ?? "")?.[1];
    paragraphs.push({ text, ...(heading ? { heading: Number(heading) } : {}) });
    if (truncated) break;
  }
  return { paragraphs, truncated };
}
