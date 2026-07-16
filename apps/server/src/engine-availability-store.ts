import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type EngineAvailabilityEvidenceSource = "provider_run" | "operator_probe" | "legacy_recovery";

export interface EngineAvailabilityEvidence {
  engineId: string;
  available: boolean;
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

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "engine-availability.jsonl");
    if (!existsSync(this.filePath)) return;
    for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<EngineAvailabilityEvidence>;
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

  record(input: Omit<EngineAvailabilityEvidence, "observedAt"> & { observedAt?: string }): EngineAvailabilityEvidence {
    const evidence: EngineAvailabilityEvidence = {
      engineId: input.engineId,
      available: input.available,
      ...(input.detail ? { detail: input.detail.slice(0, 1_000) } : {}),
      source: input.source,
      observedAt: input.observedAt ?? new Date().toISOString(),
    };
    appendFileSync(this.filePath, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(this.filePath, 0o600);
    this.latest.set(evidence.engineId, evidence);
    return evidence;
  }
}
