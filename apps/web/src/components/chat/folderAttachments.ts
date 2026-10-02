/** Folder attachment is a bounded, stored ZIP, not server-side filesystem access.
 * No extraction or font installation is performed by the uploader. */
const MAX_ENTRIES = 2_048;
const MAX_DEPTH = 16;
const MAX_PATH_BYTES = 1_024;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function safePath(path: string): string {
  const parts = path.split("/");
  if (parts.length > MAX_DEPTH || encoder.encode(path).length > MAX_PATH_BYTES ||
      parts.some(part => !part || part === "." || part === "..") ||
      /[\\:\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(path)) {
    throw new Error("The folder contains an unsafe or excessively deep filename. Nothing was attached.");
  }
  return path;
}

function excluded(path: string): boolean {
  return path.split("/").some(part => part.startsWith(".") ||
    /^(node_modules|credentials(?:\..*)?|secrets(?:\..*)?|id_rsa|id_ed25519)$/iu.test(part) ||
    /\.(pem|key|p12|pfx|kdbx)$/iu.test(part));
}

function callbackResult<T>(operation: (resolve: (value: T) => void, reject: (error: unknown) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Reading the folder timed out. Nothing was attached.")), 10_000);
    try { operation(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
}

type FolderFile = { path: string; file: File };

export async function packageFolder(files: readonly FolderFile[], maxBytes: number, checkActive: () => void = () => {}): Promise<File> {
  if (!files.length || files.length > MAX_ENTRIES) throw new Error("Choose a non-empty folder with at most 2,048 entries.");
  const names = new Set<string>();
  const entries = files.map(({ path, file }) => {
    safePath(path);
    if (names.has(path)) throw new Error("The folder contains duplicate paths. Nothing was attached.");
    names.add(path);
    return { path, file, name: encoder.encode(path) };
  });
  // Include all ZIP overhead before reading file contents. No partial archive.
  const size = entries.reduce((sum, entry) => sum + entry.file.size + 76 + entry.name.length * 2, 22);
  if (!Number.isSafeInteger(size) || size > maxBytes) throw new Error(`The folder ZIP exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB. Nothing was attached.`);
  const parts: BlobPart[] = [];
  const directory: BlobPart[] = [];
  let offset = 0;
  for (const entry of entries) {
    checkActive();
    let crc = 0xffffffff;
    // CRC scanning yields between bounded chunks rather than blocking on 80 MiB.
    for (let start = 0; start < entry.file.size; start += 64 * 1024) {
      const bytes = new Uint8Array(await entry.file.slice(start, start + 64 * 1024).arrayBuffer());
      for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
      checkActive();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true);
    l.setUint16(12, 33, true); // 1980-01-01; no host timestamps or permissions.
    l.setUint32(14, crc, true); l.setUint32(18, entry.file.size, true); l.setUint32(22, entry.file.size, true);
    l.setUint16(26, entry.name.length, true);
    const central = new Uint8Array(46);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true);
    c.setUint32(20, entry.file.size, true); c.setUint32(24, entry.file.size, true);
    c.setUint16(28, entry.name.length, true); c.setUint32(42, offset, true);
    parts.push(local, entry.name, entry.file);
    directory.push(central, entry.name);
    offset += local.length + entry.name.length + entry.file.size;
  }
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, size - offset - end.length, true); e.setUint32(16, offset, true);
  checkActive();
  // Leave room for .zip in the server's 160-byte display-name budget.
  let stem = "";
  for (const character of entries[0]!.path.split("/")[0]!.normalize("NFKC")) {
    if (encoder.encode(stem + character).length > 140) break;
    stem += character;
  }
  return new File([...parts, ...directory, end], `${stem.trim() || "folder"}.zip`, { type: "application/zip" });
}

/** Capture entries synchronously during drop; browsers revoke DataTransfer later. */
export function droppedAttachmentEntries(transfer: DataTransfer): Array<FileSystemEntry | File> {
  const items = Array.from(transfer.items).filter(item => item.kind === "file");
  return items.length ? items.flatMap(item => {
    const entry = item.webkitGetAsEntry?.();
    const file = entry ?? item.getAsFile();
    return file ? [file] : [];
  }) : Array.from(transfer.files);
}

async function prepareFolderAttachments(input: readonly (FileSystemEntry | File)[], maxBytes: number,
  checkActive: () => void = () => {}): Promise<{ files: File[]; skipped: number }> {
  if (input.length > MAX_ENTRIES) throw new Error("The selection exceeds 2,048 entries. Nothing was attached.");
  const started = Date.now();
  let visited = 0, skipped = 0, total = 0;
  const check = () => { checkActive(); if (Date.now() - started > 30_000) throw new Error("Folder preparation timed out. Nothing was attached."); };
  const collected: File[] = [];
  for (const root of input) {
    check();
    if (root instanceof File && !root.webkitRelativePath) { collected.push(root); continue; }
    if (root instanceof File) continue; // Folder-picker files are grouped below.
    if (root.isFile) { collected.push(await callbackResult<File>((yes, no) => (root as FileSystemFileEntry).file(yes, no))); continue; }
    const folder: FolderFile[] = [];
    const walk = async (entry: FileSystemEntry, parent: string): Promise<void> => {
      check();
      if (++visited > MAX_ENTRIES) throw new Error("The folder exceeds 2,048 entries. Nothing was attached.");
      const relative = safePath(parent ? `${parent}/${entry.name}` : entry.name);
      if (excluded(relative)) { skipped++; return; }
      if (entry.isFile) {
        const file = await callbackResult<File>((yes, no) => (entry as FileSystemFileEntry).file(yes, no));
        total += file.size;
        if (total > maxBytes) throw new Error("The selected folders exceed the attachment size limit. Nothing was attached.");
        folder.push({ path: relative, file });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // readEntries is paginated (not just the first browser batch).
        while (true) {
          const batch = await callbackResult<FileSystemEntry[]>((yes, no) => reader.readEntries(yes, no));
          if (!batch.length) break;
          for (const child of batch) await walk(child, relative);
        }
      } else throw new Error("This folder entry cannot be read. Nothing was attached.");
    };
    await walk(root, "");
    if (folder.length) collected.push(await packageFolder(folder, maxBytes, check));
  }
  const picked = new Map<string, FolderFile[]>();
  for (const file of input) {
    if (!(file instanceof File) || !file.webkitRelativePath) continue;
    check();
    if (++visited > MAX_ENTRIES) throw new Error("The folder exceeds 2,048 entries. Nothing was attached.");
    const relative = safePath(file.webkitRelativePath);
    if (excluded(relative)) { skipped++; continue; }
    total += file.size;
    if (total > maxBytes) throw new Error("The selected folders exceed the attachment size limit. Nothing was attached.");
    const root = relative.split("/")[0]!;
    const group = picked.get(root) ?? []; group.push({ path: relative, file }); picked.set(root, group);
  }
  for (const folder of picked.values()) collected.push(await packageFolder(folder, maxBytes, check));
  if (!collected.length) throw new Error("The folder is empty or contains only excluded hidden/sensitive files. Nothing was attached.");
  if (collected.reduce((sum, file) => sum + file.size, 0) > maxBytes) throw new Error("The selection exceeds the attachment size limit. Nothing was attached.");
  check();
  return { files: collected, skipped };
}

export async function collectAttachments(input: readonly (FileSystemEntry | File)[], maxBytes: number,
  checkActive: () => void = () => {}): Promise<{ files: File[]; skipped: number }> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () => new Error("Folder preparation timed out. Nothing was attached.");
  const check = () => { checkActive(); if (expired) throw timeoutError(); };
  try {
    return await Promise.race([
      prepareFolderAttachments(input, maxBytes, check),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { expired = true; reject(timeoutError()); }, 30_000); }),
    ]);
  } finally { clearTimeout(timer); }
}
