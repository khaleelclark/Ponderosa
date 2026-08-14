import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import type { ProviderFailureCategory } from "@ponderosa/core";

export type EngineAvailabilityEvidenceSource = "provider_run" | "operator_probe";

export interface EngineAvailabilityEvidence {
  engineId: string;
  available: boolean;
  failureCategory?: ProviderFailureCategory;
  detail?: string;
  source: EngineAvailabilityEvidenceSource;
  observedAt: string;
}

/**
 * Append-only operational evidence about real provider access. A configured
 * credential is deliberately not evidence that the provider will accept work.
 */
export class EngineAvailabilityStore {
  private readonly filePath: string;
  private readonly latest = new Map<string, EngineAvailabilityEvidence>();
  private appendNeedsSeparator = false;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "engine-availability.jsonl");
    if (!existsSync(this.filePath)) return;
    const contents = readFileSync(this.filePath, "utf8");
    this.appendNeedsSeparator = contents.length > 0 && !contents.endsWith("\n");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<EngineAvailabilityEvidence>;
        if (typeof value.engineId !== "string" || typeof value.available !== "boolean" ||
            typeof value.observedAt !== "string" ||
            !["provider_run", "operator_probe"].includes(value.source ?? "")) continue;
        this.latest.set(value.engineId, {
          engineId: value.engineId,
          available: value.available,
          ...(["authentication", "rate_limit", "capacity", "context_length", "invalid_request", "unavailable", "unknown"].includes(
            value.failureCategory ?? "",
          ) ? { failureCategory: value.failureCategory as ProviderFailureCategory } : {}),
          ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
          source: value.source as EngineAvailabilityEvidenceSource,
          observedAt: value.observedAt,
        });
      } catch {
        // A partial trailing line after a host crash is not affirmative evidence.
      }
    }
  }

  get(engineId: string): EngineAvailabilityEvidence | undefined {
    return this.latest.get(engineId);
  }

  denial(engineId: string): EngineAvailabilityEvidence | undefined {
    const evidence = this.latest.get(engineId);
    return evidence && !evidence.available ? evidence : undefined;
  }

  record(input: Omit<EngineAvailabilityEvidence, "observedAt"> & { observedAt?: string }): EngineAvailabilityEvidence {
    const evidence: EngineAvailabilityEvidence = {
      engineId: input.engineId,
      available: input.available,
      ...(input.failureCategory ? { failureCategory: input.failureCategory } : {}),
      ...(input.detail ? { detail: input.detail.slice(0, 1_000) } : {}),
      source: input.source,
      observedAt: input.observedAt ?? new Date().toISOString(),
    };
    this.appendDurable(evidence);
    this.latest.set(evidence.engineId, evidence);
    return evidence;
  }

  private appendDurable(record: EngineAvailabilityEvidence): void {
    const existed = existsSync(this.filePath);
    const descriptor = openSync(this.filePath, "a", 0o600);
    try {
      const body = Buffer.from(`${this.appendNeedsSeparator ? "\n" : ""}${JSON.stringify(record)}\n`, "utf8");
      let written = 0;
      while (written < body.length) {
        const next = writeSync(descriptor, body, written, body.length - written);
        if (next <= 0) throw new Error("engine availability evidence write made no progress");
        written += next;
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.appendNeedsSeparator = false;
    chmodSync(this.filePath, 0o600);
    if (!existed && process.platform !== "win32") {
      const directory = openSync(path.dirname(this.filePath), "r");
      try { fsyncSync(directory); }
      finally { closeSync(directory); }
    }
  }
}
