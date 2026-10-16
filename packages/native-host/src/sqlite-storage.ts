import path from "node:path";
import { storageBinding } from "./storage-binding.js";
import { storageNativePath } from "./storage-binding.js";

// Initialize through better-sqlite3's extension API, so registration belongs to
// its exact SQLite library. No second SQLite library is linked by native-host.
const registered = new WeakSet<object>();
export function prepareSqliteStorage(Database: {
  new (path: string): { loadExtension(path: string, entry: string): unknown; close(): void };
}): void {
  if (process.platform === "linux" || registered.has(Database)) return;
  const bootstrap = new Database(":memory:");
  try {
    bootstrap.loadExtension(storageNativePath, "sqlite3_ponderosastorage_init");
    registered.add(Database);
  } finally { bootstrap.close(); }
}

/** Flat internal name bypasses better-sqlite3's pathname-directory precheck.
 * SQLite resolves this name only through the registered live root capability. */
export function storageDatabaseFilename(filename: string): string {
  if (process.platform === "linux" || filename === ":memory:") return filename;
  const name = path.resolve(filename);
  return storageBinding().storagePathRegistered(name)
    ? storageBinding().storageOperation("sqlite-name", name) as string : filename;
}
