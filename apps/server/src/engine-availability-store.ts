import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

export type EngineAvailabilityEvidenceSource = "provider_run" | "operator_probe" | "legacy_recovery";

export interface EngineAvailabilityEvidence {
  engineId: string;
  available: boolean;
  detail?: string;
  source: EngineAvailabilityEvidenceSource;
  observedAt: string;
}

interface EngineAvailabilityMigrationEvidence {
  kind: "migration";
  migrationId: string;
  completedAt: string;
}

/**
 * Append-only operational evidence about real provider access. A configured
 * credential is deliberately not evidence that the provider will accept work.
 */
export class EngineAvailabilityStore {
  private readonly filePath: string;
  private readonly latest = new Map<string, EngineAvailabilityEvidence>();
  private readonly completedMigrations = new Set<string>();
  private appendNeedsSeparator = false;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "engine-availability.jsonl");
    if (!existsSync(this.filePath)) return;
    const contents = readFileSync(this.filePath, "utf8");
    this.appendNeedsSeparator = contents.length > 0 && !contents.endsWith("\n");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<EngineAvailabilityEvidence & EngineAvailabilityMigrationEvidence>;
        if (value.kind === "migration" && typeof value.migrationId === "string" &&
            typeof value.completedAt === "string") {
          this.completedMigrations.add(value.migrationId);
          continue;
        }
        if (typeof value.engineId !== "string" || typeof value.available !== "boolean" ||
            typeof value.observedAt !== "string" ||
            !["provider_run", "operator_probe", "legacy_recovery"].includes(value.source ?? "")) continue;
        this.latest.set(value.engineId, {
          engineId: value.engineId,
          available: value.available,
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

  migrationCompleted(migrationId: string): boolean {
    return this.completedMigrations.has(migrationId);
  }

  completeMigration(migrationId: string, completedAt = new Date().toISOString()): void {
    if (this.completedMigrations.has(migrationId)) return;
    const evidence: EngineAvailabilityMigrationEvidence = { kind: "migration", migrationId, completedAt };
    this.appendDurable(evidence);
    this.completedMigrations.add(migrationId);
  }

  record(input: Omit<EngineAvailabilityEvidence, "observedAt"> & { observedAt?: string }): EngineAvailabilityEvidence {
    const evidence: EngineAvailabilityEvidence = {
      engineId: input.engineId,
      available: input.available,
      ...(input.detail ? { detail: input.detail.slice(0, 1_000) } : {}),
      source: input.source,
      observedAt: input.observedAt ?? new Date().toISOString(),
    };
    this.appendDurable(evidence);
    this.latest.set(evidence.engineId, evidence);
    return evidence;
  }

  private appendDurable(record: EngineAvailabilityEvidence | EngineAvailabilityMigrationEvidence): void {
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
    if (!existed) {
      const directory = openSync(path.dirname(this.filePath), "r");
      try { fsyncSync(directory); }
      finally { closeSync(directory); }
    }
  }
}
