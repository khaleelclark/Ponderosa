import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { collectAttachments, packageFolder } from "../src/components/chat/folderAttachments.js";
import { selectComposerFiles } from "../src/components/chat/composerUtils.js";
import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";

const fileEntry = (name, body) => ({ name, isFile: true, isDirectory: false, file: resolve => resolve(new File([body], name)) });
const directory = (name, batches) => ({ name, isDirectory: true, isFile: false,
  createReader: () => { let index = 0; return { readEntries: resolve => resolve(batches[index++] ?? []) }; } });

function readStoredZip(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, "stored method, no opaque compression");
    assert.equal(bytes.readUInt16LE(offset + 6), 0x800, "UTF-8 names");
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString();
    const body = bytes.subarray(offset + 30 + nameSize, offset + 30 + nameSize + size);
    assert.equal(crc32(body), bytes.readUInt32LE(offset + 14)); files.set(name, body);
    offset += 30 + nameSize + size;
  }
  let centralCount = 0;
  const centralStart = offset;
  while (bytes.readUInt32LE(offset) === 0x02014b50) {
    const localOffset = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    offset += 46 + bytes.readUInt16LE(offset + 28); centralCount++;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x06054b50);
  assert.equal(bytes.readUInt16LE(offset + 10), centralCount);
  assert.equal(bytes.readUInt32LE(offset + 12), offset - centralStart);
  assert.equal(bytes.readUInt32LE(offset + 16), centralStart);
  assert.equal(bytes.length, offset + 22);
  return files;
}

test("folder drop consumes every readEntries batch and preserves nested Unicode paths and exact font bytes", async () => {
  const font = Buffer.from([0, 1, 0, 0, 7, 9]);
  const { files, skipped } = await collectAttachments([directory("Fonts", [
    [fileEntry(".env", "secret"), directory("node_modules", [[fileEntry("ignored.ttf", font)]]), fileEntry("Regular.ttf", font)],
    [directory("日本語", [[fileEntry("Bold.otf", "OTTO font"), fileEntry("empty.txt", "")]])],
  ])], 1_000_000);
  assert.equal(skipped, 2); assert.equal(files.length, 1); assert.equal(files[0].name, "Fonts.zip");
  const entries = readStoredZip(Buffer.from(await files[0].arrayBuffer()));
  assert.deepEqual([...entries.keys()], ["Fonts/Regular.ttf", "Fonts/日本語/Bold.otf", "Fonts/日本語/empty.txt"]);
  assert.deepEqual(entries.get("Fonts/Regular.ttf"), font);
});

test("folder-picker paths are grouped and hidden/key material is excluded", async () => {
  const picked = ["Design/type.woff2", "Design/private.pem", "Design/.git/config"].map(path => {
    const file = new File(["bytes"], path.split("/").at(-1)); Object.defineProperty(file, "webkitRelativePath", { value: path }); return file;
  });
  const result = await collectAttachments(picked, 1_000_000);
  assert.equal(result.skipped, 2);
  assert.deepEqual([...readStoredZip(Buffer.from(await result.files[0].arrayBuffer())).keys()], ["Design/type.woff2"]);
});

test("generated ZIP names are bounded header-safe ASCII without changing Unicode archive members", async () => {
  for (const root of ["Fonts", "日本語", "🎨 Fonts", "école", "長".repeat(100), "a".repeat(200)]) {
    const path = `${root}/字形.ttf`, body = Buffer.from([0, 1, 255, 7]);
    const zip = await packageFolder([{ path, file: new File([body], "字形.ttf") }], 10000);
    assert.match(zip.name, /^[\x20-\x7e]+\.zip$/);
    assert(Buffer.byteLength(zip.name) <= 144);
    assert.equal(new Headers({ "x-ponderosa-filename": zip.name }).get("x-ponderosa-filename"), zip.name);
    assert.deepEqual(readStoredZip(Buffer.from(await zip.arrayBuffer())), new Map([[path, body]]));
    if (root === "Fonts") assert.equal(zip.name, "Fonts.zip", "existing ASCII names remain unchanged");
    if (root === "日本語") assert.equal(zip.name, "folder.zip");
  }
});

test("folders reject unsafe paths, duplicates, count/byte bounds, cancellation and unreadable entries without partial output", async () => {
  for (const path of ["../font.ttf", "Fonts/../font.ttf", "C:/font.ttf", "Fonts\\font.ttf", "Fonts/bad\u202ename.ttf", "a/".repeat(17) + "font.ttf", "日".repeat(400)]) {
    await assert.rejects(packageFolder([{ path, file: new File(["font"], "font.ttf") }], 10000));
  }
  const entry = { path: "Fonts/font.ttf", file: new File(["font"], "font.ttf") };
  await assert.rejects(packageFolder([entry, entry], 10000), /duplicate/);
  const zip = await packageFolder([entry], 10000);
  const longName = await packageFolder([{ ...entry, path: "長".repeat(100) + "/font.ttf" }], 10000);
  assert(longName.name.endsWith(".zip")); assert(Buffer.byteLength(longName.name) <= 144);
  assert.equal((await packageFolder([entry], zip.size)).size, zip.size);
  await assert.rejects(packageFolder([entry], zip.size - 1), /exceeds/);
  await assert.rejects(collectAttachments(Array.from({ length: 2049 }, () => entry.file), 10000), /2,048/);
  await assert.rejects(collectAttachments([directory("Many", [Array.from({ length: 2048 }, (_, i) => fileEntry(`${i}.ttf`, "x"))])], 1_000_000), /2,048/);
  await assert.rejects(collectAttachments([directory("Fonts", [[fileEntry("font.ttf", "font")]])], 10000, () => { throw new Error("cancelled"); }), /cancelled/);
  await assert.rejects(collectAttachments([{ name: "Fonts", isDirectory: true, createReader: () => ({ readEntries: (_yes, no) => no(new Error("unreadable")) }) }], 10000), /unreadable/);
  await assert.rejects(collectAttachments([directory("Empty", [])], 10000), /empty/);
  const originalNow = Date.now; let ticks = 0;
  try {
    Date.now = () => ticks++ ? 30001 : 0;
    await assert.rejects(collectAttachments([directory("Timeout", [])], 10000), /timed out/);
  } finally { Date.now = originalNow; }
});

test("fonts, code, office, media and archives are admitted as opaque files while claimed known formats keep their gate", () => {
  for (const [name, type] of [["font.ttf", "font/ttf"], ["font.otf", "font/otf"], ["font.woff", "font/woff"], ["font.woff2", ""], ["code.ts", "text/typescript"], ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["movie.mp4", "video/mp4"], ["audio.wav", "audio/wav"], ["bundle.tar", "application/x-tar"], ["custom.bin", "application/octet-stream"]]) {
    const file = { name, type, size: 100 }; assert.deepEqual(selectComposerFiles([], [file], DEFAULT_ASSET_LIMITS).accepted, [file]);
  }
  for (const type of ["text/x-python", "text/x-python-script", "application/x-python-code", "text/plain", "application/octet-stream", ""]) {
    const file = { name: "script.py", type, size: 100 };
    assert.deepEqual(selectComposerFiles([], [file], DEFAULT_ASSET_LIMITS).accepted, [file], type);
  }
  const oldServerLimits = { ...DEFAULT_ASSET_LIMITS, acceptedMediaTypes: DEFAULT_ASSET_LIMITS.acceptedMediaTypes.filter(type => type !== "application/octet-stream") };
  const oldResult = selectComposerFiles([], [{ name: "script.py", type: "text/x-python", size: 100 }], oldServerLimits);
  assert.equal(oldResult.accepted.length, 0, "do not claim support when the running server still advertises the old allowlist");
  assert.match(oldResult.error, /file type is not supported/);
  assert.equal(selectComposerFiles([], [{ name: "image.png", type: "application/x-executable", size: 100 }], DEFAULT_ASSET_LIMITS).accepted.length, 0);
});
