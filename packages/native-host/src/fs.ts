/** Application-local fs boundary. Unregistered paths retain Node semantics;
 * registered storage paths use the process-held physical root. */
import * as node from "node:fs";
import * as asyncNode from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storageBinding } from "./storage-binding.js";
export * from "node:fs";

function filename(value: unknown): string | undefined {
  if (typeof value === "string") return path.resolve(value);
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  if (value instanceof URL) return fileURLToPath(value);
  return undefined;
}
function retained(value: unknown): string | undefined {
  if (process.platform === "linux") return undefined;
  const name = filename(value);
  return name && storageBinding().storagePathRegistered(name) ? name : undefined;
}
function operation(op: string, name: string, second = "", flags = 0, mode = 0o600): unknown {
  return storageBinding().storageOperation(op, name, second, flags, mode);
}
function numericFlags(flags: node.OpenMode): number {
  if (typeof flags === "number") return flags;
  const c = node.constants;
  const table: Record<string, number> = {
    r: c.O_RDONLY, "r+": c.O_RDWR, rs: c.O_RDONLY | c.O_SYNC, "rs+": c.O_RDWR | c.O_SYNC,
    w: c.O_WRONLY | c.O_CREAT | c.O_TRUNC, wx: c.O_WRONLY | c.O_CREAT | c.O_TRUNC | c.O_EXCL,
    "w+": c.O_RDWR | c.O_CREAT | c.O_TRUNC, "wx+": c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_EXCL,
    a: c.O_WRONLY | c.O_CREAT | c.O_APPEND, ax: c.O_WRONLY | c.O_CREAT | c.O_APPEND | c.O_EXCL,
    "a+": c.O_RDWR | c.O_CREAT | c.O_APPEND, "ax+": c.O_RDWR | c.O_CREAT | c.O_APPEND | c.O_EXCL,
  };
  if (!(flags in table)) throw new TypeError("unsupported retained file flags");
  return table[flags]!;
}
export const openSync: typeof node.openSync = ((name: node.PathLike, flags: node.OpenMode, mode?: node.Mode) => {
  const root = retained(name);
  return root ? operation("open", root, "", numericFlags(flags), typeof mode === "string" ? parseInt(mode, 8) : mode ?? 0o666) : node.openSync(name, flags, mode);
}) as typeof node.openSync;
export const closeSync: typeof node.closeSync = (fd) => {
  if (process.platform === "linux" || !storageBinding().closeStorageFile(fd)) node.closeSync(fd);
};
export const fsyncSync: typeof node.fsyncSync = fd => {
  if (process.platform !== "win32" || !storageBinding().syncStorageFile(fd)) node.fsyncSync(fd);
};
function usingFile<T>(name: node.PathLike | number, flags: node.OpenMode, action: (fd: number) => T, mode?: node.Mode): T {
  if (typeof name === "number") return action(name);
  const fd = openSync(name, flags, mode);
  try { return action(fd); } finally { closeSync(fd); }
}
export const readFileSync: typeof node.readFileSync = ((name: node.PathOrFileDescriptor, options?: any) =>
  retained(name) ? usingFile(name, options?.flag ?? "r", fd => node.readFileSync(fd, options)) : node.readFileSync(name, options)) as typeof node.readFileSync;
export const writeFileSync: typeof node.writeFileSync = ((name: node.PathOrFileDescriptor, body: any, options?: any) =>
  retained(name) ? usingFile(name, options?.flag ?? "w", fd => node.writeFileSync(fd, body, options), options?.mode) : node.writeFileSync(name, body, options)) as typeof node.writeFileSync;
export const appendFileSync: typeof node.appendFileSync = ((name: node.PathOrFileDescriptor, body: any, options?: any) =>
  retained(name) ? usingFile(name, options?.flag ?? "a", fd => node.writeFileSync(fd, body, options), options?.mode) : node.appendFileSync(name, body, options)) as typeof node.appendFileSync;
function retainedStat(name: node.PathLike, options: any, symbolic: boolean): any {
  const root = retained(name);
  if (!root) return symbolic ? node.lstatSync(name, options) : node.statSync(name, options);
  try {
    if (process.platform === "win32") return usingFile(name, "r", fd => node.fstatSync(fd, options));
    const fields = operation(symbolic ? "lstat" : "stat", root) as Record<string, bigint>;
    // Reuse Node's exact Stats/BigIntStats prototype, inspecting only the root
    // directory to construct it; never open the target database for metadata.
    const boundary = root.indexOf(path.sep, root.indexOf(".__ponderosa_storage__") + ".__ponderosa_storage__".length + 1);
    const authorityRoot = boundary < 0 ? root : root.slice(0, boundary);
    const result = usingFile(authorityRoot, "r", fd => node.fstatSync(fd, options));
    for (const [key, value] of Object.entries(fields)) {
      if (key.endsWith("Ns")) {
        const stem = key.slice(0, -2);
        if (options?.bigint) (result as any)[key] = value;
        (result as any)[stem + "Ms"] = options?.bigint ? value / 1_000_000n : Number(value) / 1e6;
        (result as any)[stem] = new Date(Number(value / 1_000_000n));
      } else (result as any)[key] = options?.bigint ? value : Number(value);
    }
    return result;
  }
  catch (error) { if (options?.throwIfNoEntry === false && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export const statSync: typeof node.statSync = ((name: node.PathLike, options?: any) => retainedStat(name, options, false)) as typeof node.statSync;
export const lstatSync: typeof node.lstatSync = ((name: node.PathLike, options?: any) => retainedStat(name, options, true)) as typeof node.lstatSync;
export const existsSync: typeof node.existsSync = name => {
  if (!retained(name)) return node.existsSync(name);
  try { statSync(name); return true; }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
};
export const mkdirSync: typeof node.mkdirSync = ((name: node.PathLike, options?: any) => {
  const root = retained(name); if (!root) return node.mkdirSync(name, options);
  const mode = typeof options === "number" ? options : options?.mode ?? 0o777;
  operation("mkdir", root, "", options?.recursive ? 1 : 0, mode); return undefined;
}) as typeof node.mkdirSync;
interface Entry { name: string; kind: "file" | "directory" | "symlink" | "other" }
export const readdirSync: typeof node.readdirSync = ((name: node.PathLike, options?: any) => {
  const root = retained(name); if (!root) return node.readdirSync(name, options);
  const entries = operation("list", root) as Entry[];
  return entries.map(entry => {
    const name = options === "buffer" || options?.encoding === "buffer" ? Buffer.from(entry.name) : entry.name;
    return options?.withFileTypes ? Object.assign(Object.create(node.Dirent.prototype), {
      name, parentPath: root, path: root, isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory",
      isSymbolicLink: () => entry.kind === "symlink", isBlockDevice: () => false, isCharacterDevice: () => false,
      isFIFO: () => false, isSocket: () => false,
    }) : name;
  });
}) as typeof node.readdirSync;
export const opendirSync: typeof node.opendirSync = ((name: node.PathLike, options?: any) => {
  if (!retained(name)) return node.opendirSync(name, options);
  const native = storageBinding(); const handle = native.openStorageDirectory(filename(name)!); let closed = false;
  return {
    path: filename(name),
    readSync: () => {
      if (closed) throw new Error("directory is closed");
      const entry = native.readStorageDirectory(handle); if (!entry) return null;
      return Object.assign(Object.create(node.Dirent.prototype), { name: entry.name, parentPath: filename(name),
        isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory", isSymbolicLink: () => entry.kind === "symlink",
        isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false });
    },
    closeSync: () => { if (!closed) { native.readStorageDirectory(handle, true); closed = true; } },
  };
}) as typeof node.opendirSync;
export const unlinkSync: typeof node.unlinkSync = name => { const root = retained(name); if (root) operation("unlink", root); else node.unlinkSync(name); };
export const rmdirSync: typeof node.rmdirSync = (name, options) => { const root = retained(name); if (root) operation("rmdir", root); else node.rmdirSync(name, options); };
export const renameSync: typeof node.renameSync = (from, to) => {
  if (retained(from) || retained(to)) {
    if (!retained(from) || !retained(to)) throw Object.assign(new Error("storage rename cannot cross authority"), { code: "EXDEV" });
    operation("rename", filename(from)!, filename(to)!);
  } else node.renameSync(from, to);
};
export const linkSync: typeof node.linkSync = (from, to) => {
  if (retained(from) || retained(to)) {
    if (!retained(from) || !retained(to)) throw Object.assign(new Error("storage link cannot cross authority"), { code: "EXDEV" });
    operation("link", filename(from)!, filename(to)!);
  } else node.linkSync(from, to);
};
export const rmSync: typeof node.rmSync = (name, options) => {
  if (!retained(name)) return node.rmSync(name, options);
  try {
    const metadata = lstatSync(name);
    if (metadata.isDirectory()) {
      if (options?.recursive) for (const child of readdirSync(name)) rmSync(path.join(filename(name)!, child), options);
      rmdirSync(name);
    } else unlinkSync(name);
  } catch (error) { if (!(options?.force && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error; }
};
export const chmodSync: typeof node.chmodSync = (name, mode) => { if (retained(name)) usingFile(name, "r", fd => node.fchmodSync(fd, mode)); else node.chmodSync(name, mode); };
export const truncateSync: typeof node.truncateSync = (name, length) => { if (retained(name)) usingFile(name, "r+", fd => node.ftruncateSync(fd, length)); else node.truncateSync(name, length); };
export const copyFileSync: typeof node.copyFileSync = (from, to, mode) => {
  if (!retained(from) && !retained(to)) return node.copyFileSync(from, to, mode);
  usingFile(from, "r", input => usingFile(to, (mode ?? 0) & node.constants.COPYFILE_EXCL ? "wx" : "w", output => {
    const body = Buffer.alloc(256 * 1024); let position = 0;
    for (;;) { const size = node.readSync(input, body, 0, body.length, position); if (!size) break;
      for (let offset = 0; offset < size;) offset += node.writeSync(output, body, offset, size - offset);
      position += size;
    }
  }));
};
export const readlinkSync: typeof node.readlinkSync = ((name: node.PathLike, options?: any) => {
  const root = retained(name); if (!root) return node.readlinkSync(name, options);
  const result = operation("readlink", root) as string; return options === "buffer" || options?.encoding === "buffer" ? Buffer.from(result) : result;
}) as typeof node.readlinkSync;
export const realpathSync: typeof node.realpathSync = Object.assign(((name: node.PathLike, options?: any) => {
  const root = retained(name); if (!root) return node.realpathSync(name, options);
  const resolved = operation("realpath", root) as string;
  return options === "buffer" || options?.encoding === "buffer" ? Buffer.from(resolved) : resolved;
}) as typeof node.realpathSync, { native: ((name: node.PathLike, options?: any) => realpathSync(name, options)) as typeof node.realpathSync.native });

export const createReadStream: typeof node.createReadStream = (name, options) => {
  if (!retained(name)) return node.createReadStream(name, options);
  const opts = typeof options === "string" ? { encoding: options } : options ?? {};
  const fd = openSync(name, opts.flags ?? "r", opts.mode);
  // Node streams must close through this boundary so native ownership outlives
  // every open fd and is released on end, cancellation or read failure.
  const stream = node.createReadStream(name, { ...opts, fd, autoClose: false });
  let closed = false;
  const close = () => { if (!closed) { closeSync(fd); closed = true; } };
  stream.once("end", close); stream.once("error", close); stream.once("close", close);
  return stream;
};

class RetainedFile {
  #closed = false;
  readonly #descriptor: number;
  constructor(descriptor: number) { this.#descriptor = descriptor; }
  get fd(): number { return this.#closed ? -1 : this.#descriptor; }
  async close(): Promise<void> { if (!this.#closed) { closeSync(this.#descriptor); this.#closed = true; } }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
  async readFile(options?: any): Promise<any> { return node.readFileSync(this.fd, options); }
  async writeFile(body: any, options?: any): Promise<void> { node.writeFileSync(this.fd, body, options); }
  async appendFile(body: any, options?: any): Promise<void> { node.writeFileSync(this.fd, body, options); }
  async stat(options?: any): Promise<any> { return node.fstatSync(this.fd, options); }
  async sync(): Promise<void> { fsyncSync(this.fd); }
  async datasync(): Promise<void> { node.fdatasyncSync(this.fd); }
  async truncate(length?: number): Promise<void> { node.ftruncateSync(this.fd, length); }
  async chmod(mode: node.Mode): Promise<void> { node.fchmodSync(this.fd, mode); }
  async read(buffer: Buffer, offset = 0, length = buffer.length, position: number | null = null): Promise<any> { return { bytesRead: node.readSync(this.fd, buffer, offset, length, position), buffer }; }
  async write(body: Buffer | string, offset?: any, length?: any, position?: any): Promise<any> { return { bytesWritten: typeof body === "string" ? node.writeSync(this.fd, body, offset, length) : node.writeSync(this.fd, body, offset, length, position), buffer: body }; }
}
export const promises: typeof asyncNode = {
  ...asyncNode,
  open: (async (name: node.PathLike, flags: node.OpenMode, mode?: node.Mode) => retained(name) ? new RetainedFile(openSync(name, flags, mode)) : asyncNode.open(name, flags, mode)) as typeof asyncNode.open,
  readFile: (async (name: any, options?: any) => retained(name) ? readFileSync(name, options) : asyncNode.readFile(name, options)) as typeof asyncNode.readFile,
  writeFile: (async (name: any, body: any, options?: any) => retained(name) ? writeFileSync(name, body, options) : asyncNode.writeFile(name, body, options)) as typeof asyncNode.writeFile,
  appendFile: (async (name: any, body: any, options?: any) => retained(name) ? appendFileSync(name, body, options) : asyncNode.appendFile(name, body, options)) as typeof asyncNode.appendFile,
  stat: (async (name: any, options?: any) => retained(name) ? statSync(name, options) : asyncNode.stat(name, options)) as typeof asyncNode.stat,
  lstat: (async (name: any, options?: any) => retained(name) ? lstatSync(name, options) : asyncNode.lstat(name, options)) as typeof asyncNode.lstat,
  mkdir: (async (name: any, options?: any) => retained(name) ? mkdirSync(name, options) : asyncNode.mkdir(name, options)) as typeof asyncNode.mkdir,
  readdir: (async (name: any, options?: any) => retained(name) ? readdirSync(name, options) : asyncNode.readdir(name, options)) as typeof asyncNode.readdir,
  link: async (from, to) => retained(from) || retained(to) ? linkSync(from, to) : asyncNode.link(from, to),
  rename: async (from, to) => retained(from) || retained(to) ? renameSync(from, to) : asyncNode.rename(from, to),
  unlink: async name => retained(name) ? unlinkSync(name) : asyncNode.unlink(name),
  rm: async (name, options) => retained(name) ? rmSync(name, options) : asyncNode.rm(name, options),
  rmdir: async (name, options) => retained(name) ? rmdirSync(name, options) : asyncNode.rmdir(name, options),
  chmod: async (name, mode) => retained(name) ? chmodSync(name, mode) : asyncNode.chmod(name, mode),
  access: async (name, mode) => { if (retained(name)) usingFile(name, mode && mode & node.constants.W_OK ? "r+" : "r", () => undefined); else await asyncNode.access(name, mode); },
  realpath: (async (name: any, options?: any) => retained(name) ? realpathSync(name, options) : asyncNode.realpath(name, options)) as typeof asyncNode.realpath,
  copyFile: async (from, to, mode) => retained(from) || retained(to) ? copyFileSync(from, to, mode) : asyncNode.copyFile(from, to, mode),
  readlink: (async (name: any, options?: any) => retained(name) ? readlinkSync(name, options) : asyncNode.readlink(name, options)) as typeof asyncNode.readlink,
};
const applicationFs: typeof node = { ...node, createReadStream, fsyncSync, openSync, closeSync, readFileSync, writeFileSync, appendFileSync, statSync, lstatSync, existsSync, mkdirSync, readdirSync, opendirSync, unlinkSync, rmdirSync, renameSync, linkSync, rmSync, chmodSync, truncateSync, copyFileSync, readlinkSync, realpathSync, promises };
export default applicationFs;
