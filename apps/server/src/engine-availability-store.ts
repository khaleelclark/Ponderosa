import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  normalizeProviderFailureCategory,
  type ProviderFailureCategory,
} from "@ponderosa/core";

export type EngineAvailabilityEvidenceSource = "provider_run" | "operator_probe";

export interface EngineAvailabilityEvidence {
  engineId: string;
  available: boolean;
  failureCategory?: ProviderFailureCategory;
  detail?: string;
  source: EngineAvailabilityEvidenceSource;
  observedAt: string;
  /** Legacy records have no provenance and cannot qualify a new artifact. */
  buildRevision?: string;
  instanceId?: string;
}

/**
 * Append-only operational evidence about real provider access. A configured
 * credential is deliberately not evidence that the provider will accept work.
 */
export class EngineAvailabilityStore {
  readonly servingBuildRevision: string;
  readonly servingInstanceId: string;
  private readonly filePath: string;
  private readonly latest = new Map<string, EngineAvailabilityEvidence>();
  private appendNeedsSeparator = false;

  constructor(dataDir: string, buildRevision: string = "development", private readonly changed: (id: string) => void = () => {}) {
    this.servingBuildRevision = buildRevision;
    this.servingInstanceId = randomUUID();
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
        const hasFailureCategory = Object.prototype.hasOwnProperty.call(
          value,
          "failureCategory",
        );
        this.latest.set(value.engineId, {
          engineId: value.engineId,
          available: value.available,
          ...(hasFailureCategory
            ? { failureCategory: normalizeProviderFailureCategory(value.failureCategory) }
            : {}),
          ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
          source: value.source as EngineAvailabilityEvidenceSource,
          observedAt: value.observedAt,
          ...(typeof value.buildRevision === "string" ? { buildRevision: value.buildRevision } : {}),
          ...(typeof value.instanceId === "string" ? { instanceId: value.instanceId } : {}),
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

  record(input: Omit<EngineAvailabilityEvidence, "observedAt" | "buildRevision" | "instanceId"> & { observedAt?: string; operationStartedAt?: string }): EngineAvailabilityEvidence {
    const newerDenial = this.denial(input.engineId);
    if (input.available && input.operationStartedAt && newerDenial && newerDenial.observedAt >= input.operationStartedAt) return newerDenial;
    const hasFailureCategory = Object.prototype.hasOwnProperty.call(
      input,
      "failureCategory",
    );
    const evidence: EngineAvailabilityEvidence = {
      engineId: input.engineId,
      available: input.available,
      ...(hasFailureCategory
        ? { failureCategory: normalizeProviderFailureCategory(input.failureCategory) }
        : {}),
      ...(input.detail ? { detail: input.detail.slice(0, 1_000) } : {}),
      source: input.source,
      observedAt: input.observedAt ?? new Date().toISOString(),
      buildRevision: this.servingBuildRevision,
      instanceId: this.servingInstanceId,
    };
    this.appendDurable(evidence);
    this.latest.set(evidence.engineId, evidence);
    this.changed(evidence.engineId);
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
