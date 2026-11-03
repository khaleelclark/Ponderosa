/** Exact installation recovery data belongs in transactional large-object storage.
 * A failed durable write holds confirmation; it never starts an untracked import. */
const DATABASE = "ponderosa-branch-package-commands";
function openJournal(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("commands");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Installation recovery storage unavailable; confirmation held."));
    request.onblocked = () => reject(new Error("Close another Ponderosa tab to open installation recovery storage."));
  });
}
export async function readPackageCommand(key: string): Promise<unknown> {
  const db = await openJournal();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("commands", "readonly");
      const read = tx.objectStore("commands").get(key);
      tx.oncomplete = () => resolve(read.result);
      tx.onabort = tx.onerror = () => reject(new Error("Original installation command could not be read."));
    });
    // Preserve earlier exact commands. Do not clear them or turn parse failure into absence.
    if (value !== undefined) return value;
    const legacy = localStorage.getItem(key);
    return legacy ? JSON.parse(legacy) as unknown : undefined;
  } finally { db.close(); }
}
export async function savePackageCommand(key: string, command: unknown, matches: (prior: unknown) => boolean): Promise<void> {
  const db = await openJournal();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("commands", "readwrite"), store = tx.objectStore("commands");
      let conflict = false;
      const read = store.get(key);
      read.onsuccess = () => {
        try {
          const legacy = read.result === undefined ? localStorage.getItem(key) : null;
          const prior: unknown = read.result ?? (legacy ? JSON.parse(legacy) : undefined);
          if (prior !== undefined && !matches(prior)) { conflict = true; tx.abort(); return; }
          if (read.result === undefined) store.add(command, key);
        } catch { conflict = true; tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error(conflict
        ? "Original command differs; read its status before starting another import."
        : "Installation recovery storage is full or unavailable; confirmation held."));
    });
  } finally { db.close(); }
}
