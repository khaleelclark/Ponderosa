/** Folder attachment is a bounded, stored ZIP, not server-side filesystem access.
 * No extraction or font installation is performed by the uploader. */
export const MAX_FOLDER_ENTRIES = 2_048;
export const FOLDER_PICKER_NOTE = "Some folder pickers omit hidden files. Use an existing ZIP when you need the complete folder.";
const MAX_DEPTH = 16;
const MAX_PATH_BYTES = 1_024;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

export function safeFolderPath(path: string): string {
  const parts = path.split("/");
  if (parts.length > MAX_DEPTH || encoder.encode(path).length > MAX_PATH_BYTES ||
      parts.some(part => !part || part === "." || part === "..") ||
      /[\\:\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(path)) {
    throw new Error(`${path}: Unsafe path, depth over 16 components, or path over 1,024 bytes. Rename or move the item and retry; nothing was attached.`);
  }
  return path;
}

export type FolderExclusion = {
  path: string;
  kind: "file" | "folder";
  reason: string;
  canInclude: boolean;
};
export type FolderImport = {
  name: string;
  input: Array<FileSystemEntry | File>;
  file?: File;
  excluded: FolderExclusion[];
  included: string[];
  fileCount: number;
  paths: string[];
};

/** Filename advice only: contents are never inspected for credentials. */
export function folderExclusion(name: string): Pick<FolderExclusion, "reason" | "canInclude"> | undefined {
  if (/^(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)$/iu.test(name))
    return { reason: "Operating system metadata", canInclude: false };
  if (name.toLowerCase() === ".git") return { reason: "Git repository internals", canInclude: false };
  if (/^(node_modules|\.venv|venv|__pycache__)$/iu.test(name))
    return { reason: "Generated dependency or cache tree", canInclude: false };
  if (/^\.env(?:$|\.)/iu.test(name) && !/(?:^|\.)(example|sample|template)(?:\.|$)/iu.test(name))
    return { reason: "Environment file may contain credentials; contents were not inspected", canInclude: true };
  if (/^(\.ssh|\.aws|\.npmrc|\.pypirc|id_rsa|id_ed25519|credentials(?:\..*)?|secrets(?:\..*)?)$/iu.test(name) || /\.(pem|key|p12|pfx|kdbx)$/iu.test(name))
    return { reason: "Name may indicate credentials or a legitimate project file; contents were not inspected", canInclude: true };
  return undefined;
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
  if (!files.length || files.length > MAX_FOLDER_ENTRIES) throw new Error("Choose a non-empty folder with at most 2,048 entries.");
  const names = new Set<string>();
  const entries = files.map(({ path, file }) => {
    safeFolderPath(path);
    if (names.has(path)) throw new Error(`${path}: Duplicate path. Remove or rename the duplicate and retry; nothing was attached.`);
    names.add(path);
    return { path, file, name: encoder.encode(path) };
  });
  // Include all ZIP overhead before reading file contents. No partial archive.
  const size = entries.reduce((sum, entry) => sum + entry.file.size + 76 + entry.name.length * 2, 22);
  if (!Number.isSafeInteger(size) || size > maxBytes) throw new Error(`${files[0]!.path.split("/")[0]}: The folder ZIP exceeds ${maxBytes.toLocaleString()} bytes, including archive overhead. Choose fewer files; nothing was attached.`);
  const parts: BlobPart[] = [];
  const directory: BlobPart[] = [];
  let offset = 0;
  for (const entry of entries) {
    checkActive();
    let crc = 0xffffffff;
    // CRC scanning yields between bounded chunks rather than blocking on 80 MiB.
    for (let start = 0; start < entry.file.size; start += 64 * 1024) {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await entry.file.slice(start, start + 64 * 1024).arrayBuffer()); }
      catch (error) { throw new Error(`${entry.path}: ${error instanceof Error ? error.message : "The file could not be read."} Check access and select the folder again; nothing was attached.`); }
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
  // Upload filenames travel in a raw HTTP header. Keep the generated name
  // ASCII and bounded; the original Unicode root/member paths remain in ZIP.
  const stem = entries[0]!.path.split("/")[0]!.normalize("NFKC")
    .replace(/[^\x20-\x7e]+/gu, "_").slice(0, 140).trim();
  const name = stem.replace(/_/gu, "").trim() ? stem : "folder";
  return new File([...parts, ...directory, end], `${name}.zip`, { type: "application/zip" });
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
  checkActive: () => void, included: ReadonlySet<string>, setPath: (path: string) => void, reviewedKinds: ReadonlyMap<string, FolderExclusion["kind"]>): Promise<{ files: File[]; folders: FolderImport[] }> {
  if (input.length > MAX_FOLDER_ENTRIES) throw new Error("The selection exceeds 2,048 entries. Choose fewer items; nothing was attached.");
  let visited = 0, total = 0;
  const files: File[] = [], folders: FolderImport[] = [];
  const picked = new Map<string, File[]>();
  for (const item of input) {
    if (item instanceof File && item.webkitRelativePath) {
      safeFolderPath(item.webkitRelativePath);
      const name = item.webkitRelativePath.split("/")[0]!;
      const group = picked.get(name) ?? []; group.push(item); picked.set(name, group);
    }
  }
  const count = (path: string) => {
    setPath(path); checkActive();
    if (++visited > MAX_FOLDER_ENTRIES) throw new Error(`${path}: The selection exceeds 2,048 entries. Choose fewer items; nothing was attached.`);
  };
  const add = (target: FolderFile[], path: string, file: File) => {
    total += file.size;
    if (total > maxBytes) throw new Error(`${path}: The selected folders exceed the attachment size limit. Choose fewer files; nothing was attached.`);
    target.push({ path, file });
  };
  const prepare = async (name: string, roots: Array<FileSystemEntry | File>) => {
    const entries: FolderFile[] = [], excluded: FolderExclusion[] = [];
    const omitted = new Set<string>(), includedFound = new Set<string>();
    const omit = (path: string, kind: FolderExclusion["kind"]): boolean => {
      const parts = path.split("/");
      for (let i = 0; i < parts.length; i++) {
        const boundary = parts.slice(0, i + 1).join("/");
        const rule = folderExclusion(parts[i]!);
        if (!rule) continue;
        if (rule.canInclude && included.has(boundary)) {
          const observedKind = i < parts.length - 1 ? "folder" : kind;
          if (reviewedKinds.has(boundary) && reviewedKinds.get(boundary) !== observedKind)
            throw new Error(`${boundary}: The item changed from ${reviewedKinds.get(boundary)} to ${observedKind}. Select the folder again and review it; the attachment was not changed.`);
          includedFound.add(boundary); continue;
        }
        if (!omitted.has(boundary)) {
          omitted.add(boundary);
          excluded.push({ path: boundary, kind: i < parts.length - 1 ? "folder" : kind, ...rule });
        }
        return true;
      }
      return false;
    };
    const read = async <T>(path: string, operation: (yes: (value: T) => void, no: (error: unknown) => void) => void): Promise<T> => {
      try { return await callbackResult(operation); }
      catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : "This entry could not be read."} Check access and select the folder again; nothing was attached.`); }
    };
    const walk = async (entry: FileSystemEntry, parent: string): Promise<void> => {
      const path = safeFolderPath(parent ? `${parent}/${entry.name}` : entry.name); count(path);
      if (omit(path, entry.isDirectory ? "folder" : "file")) return;
      if (entry.isFile) add(entries, path, await read<File>(path, (yes, no) => (entry as FileSystemFileEntry).file(yes, no)));
      else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        while (true) {
          const batch = await read<FileSystemEntry[]>(path, (yes, no) => reader.readEntries(yes, no));
          checkActive();
          if (!batch.length) break;
          for (const child of batch) await walk(child, path);
        }
      } else throw new Error(`${path}: Unsupported folder entry. Select a readable folder; nothing was attached.`);
    };
    for (const root of roots) {
      if (root instanceof File) {
        const path = safeFolderPath(root.webkitRelativePath); count(path);
        if (!omit(path, "file")) add(entries, path, root);
      } else await walk(root, "");
    }
    for (const path of included) {
      if ((path === name || path.startsWith(`${name}/`)) && !includedFound.has(path)) {
        const automatic = path.split("/").map(folderExclusion).find(rule => rule && !rule.canInclude);
        if (automatic) throw new Error(`${path}: ${automatic.reason} cannot be included. Choose a project file instead; the attachment was not changed.`);
        throw new Error(`${path}: The selected item is no longer available. Select the folder again; the attachment was not changed.`);
      }
    }
    setPath(name);
    const file = entries.length ? await packageFolder(entries, maxBytes, checkActive) : undefined;
    if (file) files.push(file);
    folders.push({ name, input: roots, file, excluded, included: [...includedFound], fileCount: entries.length, paths: entries.map(entry => entry.path) });
  };
  for (const root of input) {
    checkActive();
    if (root instanceof File) { if (!root.webkitRelativePath) files.push(root); }
    else if (root.isFile) {
      setPath(root.name);
      try { files.push(await callbackResult<File>((yes, no) => (root as FileSystemFileEntry).file(yes, no))); }
      catch (error) { throw new Error(`${root.name}: ${error instanceof Error ? error.message : "This file could not be read."} Check access and select it again; nothing was attached.`); }
    }
    else await prepare(root.name, [root]);
  }
  for (const [name, roots] of picked) await prepare(name, roots);
  if (files.reduce((sum, file) => sum + file.size, 0) > maxBytes)
    throw new Error("The selection exceeds the attachment size limit. Choose fewer files; nothing was attached.");
  checkActive();
  return { files, folders };
}

export async function collectAttachments(input: readonly (FileSystemEntry | File)[], maxBytes: number,
  checkActive: () => void = () => {}, included: ReadonlySet<string> = new Set(),
  reviewedKinds: ReadonlyMap<string, FolderExclusion["kind"]> = new Map()): Promise<{ files: File[]; folders: FolderImport[] }> {
  let expired = false;
  let activePath = input[0] instanceof File ? input[0].webkitRelativePath || input[0].name : input[0]?.name || "Selected Folder";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () => new Error(`${activePath}: Folder preparation timed out. Select a smaller folder and retry; nothing was attached.`);
  const check = () => { checkActive(); if (expired) throw timeoutError(); };
  try {
    return await Promise.race([
      prepareFolderAttachments(input, maxBytes, check, included, path => { activePath = path; }, reviewedKinds),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { expired = true; reject(timeoutError()); }, 30_000); }),
    ]);
  } finally { clearTimeout(timer); }
}
