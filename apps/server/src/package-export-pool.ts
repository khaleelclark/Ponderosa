import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, statfsSync, writeSync } from 'node:fs';
import path from 'node:path';
import { allocatedHeldFileBytes, DataDirectoryAuthority, pinPortableRegularFile } from '@ponderosa/native-host';

const NAME = 'package-export-pool-v1.bin';
export const PACKAGE_EXPORT_POOL_CAPACITY = 4 * 1024 * 1024 * 1024;
export const PACKAGE_EXPORT_POOL_CHUNK_LIMIT = 1024 * 1024;
const PROC_SUPER_MAGIC = 0x9fa0;

export interface PackageExportPoolReceipt {
  version: 1;
  name: typeof NAME;
  capacity: typeof PACKAGE_EXPORT_POOL_CAPACITY;
  rootDevice: string;
  rootInode: string;
  fileDevice: string;
  fileInode: string;
}
export interface PackageExportPoolMarkers {
  readMarker(): { state: 'intent' | 'ready'; receipt: unknown } | undefined;
  /** Must durably and exclusively insert intent before returning. */
  beginCreation(): void;
  /** Must durably transition this exact intent to ready before returning. */
  completeCreation(receipt: PackageExportPoolReceipt): void;
}
export interface PackageExportPool {
  readonly receipt: PackageExportPoolReceipt;
  assert(): void;
  size(): number;
  allocatedBytes(): number;
  read(offset: number, length: number): Buffer;
  write(offset: number, bytes: Buffer): void;
  sync(): void;
  close(): void;
}

function held(message: string): never {
  throw Object.assign(new Error(message), { code: 'ERR_PACKAGE_EXPORT_POOL_CUSTODY' });
}
function numberString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,31})$/.test(value);
}
function receiptFrom(value: unknown): PackageExportPoolReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return held('Invalid export pool receipt; preserve the pool');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'capacity,fileDevice,fileInode,name,rootDevice,rootInode,version' ||
      r.version !== 1 || r.name !== NAME || r.capacity !== PACKAGE_EXPORT_POOL_CAPACITY ||
      !numberString(r.rootDevice) || !numberString(r.rootInode) || !numberString(r.fileDevice) || !numberString(r.fileInode))
    return held('Invalid export pool receipt; preserve the pool');
  return r as unknown as PackageExportPoolReceipt;
}
function bounds(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 ||
      length < 0 || length > PACKAGE_EXPORT_POOL_CHUNK_LIMIT || offset + length > PACKAGE_EXPORT_POOL_CAPACITY)
    throw new RangeError('Export pool range exceeds its bounded capacity');
}

/**
 * Opens only the locally issued pool under a retained root. The marker is in the
 * local canonical database, never imported data. No path is ever unlinked.
 *
 * On Linux, O_PATH pins a proved regular inode before the write-capable open;
 * on other platforms that upgrade and durable creation are not yet qualified.
 * A crash after intent remains held and is never silently adopted or recreated.
 */
export function openPackageExportPool(authority: DataDirectoryAuthority, markers: PackageExportPoolMarkers): PackageExportPool {
  if (process.platform !== 'linux')
    return held('Export pool custody is not qualified on this platform; preserve existing files');
  const dataDir = DataDirectoryAuthority.ownedRoot(authority);
  const match = /^\/proc\/self\/fd\/(0|[1-9][0-9]*)$/.exec(dataDir);
  if (!match || statfsSync('/proc/self/fd').type !== PROC_SUPER_MAGIC)
    return held('Export pool requires a held Linux directory descriptor and procfs');
  const rootFd = Number(match[1]);
  if (!Number.isSafeInteger(rootFd)) return held('Invalid held export root descriptor');
  const root = fstatSync(rootFd, { bigint: true });
  if (!root.isDirectory()) return held('Export root is not a directory');
  const filename = path.join(dataDir, NAME);
  let fd: number | undefined;
  let receipt: PackageExportPoolReceipt;
  const rootSame = () => {
    if (DataDirectoryAuthority.ownedRoot(authority) !== dataDir) held('Export root authority changed');
    const now = fstatSync(rootFd, { bigint: true });
    if (!now.isDirectory() || now.dev !== root.dev || now.ino !== root.ino)
      held('Held export root changed; preserve the pool');
  };
  const fileCheck = (s: ReturnType<typeof fstatSync>, r: PackageExportPoolReceipt) => {
    // BigIntStats is required at all call sites; avoid lossy device/inode comparisons.
    const v = s as unknown as import('node:fs').BigIntStats;
    if (!v.isFile() || v.dev.toString() !== r.fileDevice || v.ino.toString() !== r.fileInode ||
        v.nlink !== 1n || (v.mode & 0o7777n) !== 0o600n || v.size < 0n ||
        v.size > BigInt(PACKAGE_EXPORT_POOL_CAPACITY))
      held('Export pool identity, link count, permissions or size changed; preserve it');
  };
  const marker = markers.readMarker();
  if (marker?.state === 'intent') return held('Export pool issuance was interrupted; preserve the unverified pool');
  if (marker && marker.state !== 'ready') return held('Invalid export pool issuance marker');
  try {
    if (!marker) {
      markers.beginCreation();
      rootSame();
      // O_EXCL never opens or modifies a pre-existing name, including symlinks.
      fd = openSync(filename, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      // Apply private mode only to the just-created, exclusively held inode.
      fchmodSync(fd, 0o600);
      const file = fstatSync(fd, { bigint: true });
      receipt = { version: 1, name: NAME, capacity: PACKAGE_EXPORT_POOL_CAPACITY,
        rootDevice: root.dev.toString(), rootInode: root.ino.toString(),
        fileDevice: file.dev.toString(), fileInode: file.ino.toString() };
      fileCheck(file as unknown as ReturnType<typeof fstatSync>, receipt);
      rootSame();
      const named = lstatSync(filename, { bigint: true });
      fileCheck(named as unknown as ReturnType<typeof fstatSync>, receipt);
      fsyncSync(fd);
      fsyncSync(rootFd);
      markers.completeCreation(receipt);
    } else {
      receipt = receiptFrom(marker.receipt);
      if (receipt.rootDevice !== root.dev.toString() || receipt.rootInode !== root.ino.toString())
        return held('Export pool was issued under a different directory');
      rootSame();
      // pinPortableRegularFile checks the no-follow O_PATH inode before any
      // write-capable file open, including when the name has been replaced.
      const pin = pinPortableRegularFile({ path: filename, expectedDevice: BigInt(receipt.fileDevice), expectedInode: BigInt(receipt.fileInode) });
      try {
        fd = openSync(pin.readPath, constants.O_RDWR);
      } finally {
        closeSync(pin.fd);
      }
      fileCheck(fstatSync(fd, { bigint: true }) as unknown as ReturnType<typeof fstatSync>, receipt);
    }
    const ownedFd = fd;
    let closed = false;
    const assert = () => {
      if (closed) return held('Export pool is closed');
      rootSame();
      fileCheck(fstatSync(ownedFd, { bigint: true }) as unknown as ReturnType<typeof fstatSync>, receipt);
      fileCheck(lstatSync(filename, { bigint: true }) as unknown as ReturnType<typeof fstatSync>, receipt);
      rootSame();
    };
    assert();
    const pool: PackageExportPool = {
      receipt: Object.freeze({ ...receipt }),
      assert,
      size() { assert(); const n = Number(fstatSync(ownedFd, { bigint: true }).size); assert(); return n; },
      allocatedBytes() {
        assert(); const n = allocatedHeldFileBytes(ownedFd); assert();
        if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return held('Export pool allocation observation is out of range');
        return Number(n);
      },
      read(offset, length) {
        bounds(offset, length); assert();
        const bytes = Buffer.allocUnsafe(length);
        let used = 0;
        while (used < length) {
          const count = readSync(ownedFd, bytes, used, length - used, offset + used);
          if (!count) return held('Export pool chunk is incomplete');
          used += count;
        }
        assert();
        // Caller verifies its local immutable chunk digest before emitting bytes.
        return bytes;
      },
      write(offset, bytes) {
        if (!Buffer.isBuffer(bytes)) throw new TypeError('Export pool write requires a Buffer');
        bounds(offset, bytes.length); assert();
        let used = 0;
        while (used < bytes.length) {
          const count = writeSync(ownedFd, bytes, used, bytes.length - used, offset + used);
          if (!count) return held('Export pool write made no progress');
          used += count;
        }
        assert();
      },
      sync() { assert(); fsyncSync(ownedFd); assert(); },
      close() { if (!closed) { closed = true; closeSync(ownedFd); } },
    };
    fd = undefined;
    return pool;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
