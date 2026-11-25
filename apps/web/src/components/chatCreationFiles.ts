/** File bytes for an already requested New Chat handoff, until its draft or
 * opening message takes ownership. Session storage keeps the exact receipt. */
export async function chatCreationFiles(mode: "read" | "write" | "remove", key: string, files?: File[]): Promise<File[] | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ponderosa-chat-creation-files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(new Error("Attachment recovery storage is unavailable."));
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("files", mode === "read" ? "readonly" : "readwrite");
      const store = tx.objectStore("files");
      const request = mode === "read" ? store.get(key) :
        mode === "write" ? store.add(files, key) : store.delete(key);
      tx.oncomplete = () => resolve(mode === "read" ? request.result : undefined);
      tx.onabort = tx.onerror = () => reject(new Error("New Chat attachments could not be saved or recovered."));
    });
  } finally {
    db.close();
  }
}
