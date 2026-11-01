/** Host-selected immutable material for the current delivery, never provider-supplied paths. */
export interface RuntimeInputMaterial {
  localPath: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface RuntimeInputFile {
  id: string;
  kind: "attachment" | "artifact";
  /** Upload storage owner; it must remain the recipient Agent or its current Chat. */
  attachmentOwnerId?: string;
  source: { kind: "communication" | "activation"; id: string };
  /** The original remains available even when a derived image is submitted. */
  original: RuntimeInputMaterial;
  image?: RuntimeInputMaterial;
}

/** Existing per-delivery attachment budget also includes derived media held for submission. */
export function requireRuntimeInputFileBudget(files: readonly RuntimeInputFile[]): void {
  let total = 0;
  for (const file of files) {
    if (!file.id || !file.source.id || !["communication", "activation"].includes(file.source.kind))
      throw new Error("Typed input is missing current-delivery provenance");
    for (const material of [file.original, ...(file.image ? [file.image] : [])]) {
      if (!Number.isSafeInteger(material.byteLength) || material.byteLength < 0)
        throw new Error("Typed input has an invalid byte length");
      total += material.byteLength;
    }
    if (!Number.isSafeInteger(total) || total > 160 * 1024 * 1024)
      throw new Error("Typed input exceeds the runtime attachment byte budget");
  }
}
