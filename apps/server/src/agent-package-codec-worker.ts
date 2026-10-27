import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "@ponderosa/native-host/fs";
import { agentPackageJsonUtf8Bytes, AGENT_PACKAGE_MAX_AGENTS, AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_METADATA_MAX_BYTES, AGENT_PACKAGE_LIMIT_LABEL } from "@ponderosa/core";
import type { PackageWireEntry } from "./agent-package-codec.js";
import { stableJsonParts } from "@ponderosa/agents";
import { exactObjectFields, validatedObject } from "./object-validation.js";

const port = parentPort!;
const input = workerData as { pathname: string; packageOnly?: boolean; jsonEnvelope?: boolean };

// Only a bounded batch crosses the server event loop at once. Acknowledgement
// prevents a fast worker from queuing an entire large package in the parent.
async function parse(): Promise<void> {
  if (statSync(input.pathname).size > AGENT_PACKAGE_MAX_BYTES +
      (input.packageOnly ? 0 : AGENT_PACKAGE_METADATA_MAX_BYTES + (input.jsonEnvelope ? 12 : 1))) {
    throw new Error(`Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL}`);
  }
  let body: Buffer | undefined = readFileSync(input.pathname);
  const separator = input.packageOnly || input.jsonEnvelope ? -1 : body.indexOf(0x0a);
  if (!input.packageOnly && !input.jsonEnvelope && (separator < 1 || separator > AGENT_PACKAGE_METADATA_MAX_BYTES)) {
    throw new Error("Agent package upload metadata is invalid");
  }
  let raw: Buffer | undefined = body.subarray(separator + 1);
  if (!input.jsonEnvelope && raw.length > AGENT_PACKAGE_MAX_BYTES) throw new Error(`Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL}`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let metadata = input.packageOnly || input.jsonEnvelope ? {} : JSON.parse(decoder.decode(body.subarray(0, separator)));
  let portable: unknown = JSON.parse(decoder.decode(raw));
  let canonicalPayloadHash: string | undefined;
  if (input.jsonEnvelope) {
    const envelope = validatedObject(portable, "Agent import request");
    exactObjectFields(envelope, ["package", "conversationId", "engineMapping", "acknowledgeElevatedManagementPermissions", "chatInstructionsResolution"], "Agent import request");
    metadata = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== "package"));
    try { agentPackageJsonUtf8Bytes(metadata, AGENT_PACKAGE_METADATA_MAX_BYTES); }
    catch (error) {
      throw Object.assign(new Error(`Agent import metadata exceeds 16 KiB: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 413 });
    }
    portable = envelope.package;
    agentPackageJsonUtf8Bytes(portable);
  }
  const agents = portable && typeof portable === "object" && "agents" in portable ? portable.agents : undefined;
  if (Array.isArray(agents) && agents.length > AGENT_PACKAGE_MAX_AGENTS) {
    throw Object.assign(new Error(`Agent package contains ${agents.length} Agents; the limit is ${AGENT_PACKAGE_MAX_AGENTS}`), { statusCode: 413 });
  }
  if (input.jsonEnvelope) {
    const mapping = validatedObject(metadata.engineMapping, "Agent import engine mapping");
    if (typeof metadata.conversationId !== "string" || Object.values(mapping).some(value => typeof value !== "string") ||
        (metadata.acknowledgeElevatedManagementPermissions !== undefined && typeof metadata.acknowledgeElevatedManagementPermissions !== "boolean")) {
      throw new Error("Agent import request fields are invalid");
    }
    // Preserve the legacy normalized, canonical identity inside the already
    // memory-capped worker. Package bytes bound its structural work; do not
    // impose the smaller live-runtime canonicalization node budget on history.
    const hash = createHash("sha256");
    for (const part of stableJsonParts({
      package: portable,
      conversationId: metadata.conversationId,
      engineMapping: Object.fromEntries(Object.entries(mapping).map(([source, target]) => [source, (target as string).trim()])),
      ...(metadata.chatInstructionsResolution ? { chatInstructionsResolution: metadata.chatInstructionsResolution } : {}),
      acknowledgeElevatedManagementPermissions: metadata.acknowledgeElevatedManagementPermissions ?? false,
    }, { maxDepth: 64, maxNodes: AGENT_PACKAGE_MAX_BYTES })) hash.update(part);
    canonicalPayloadHash = hash.digest("hex");
  }
  body = undefined;
  raw = undefined;
  let batch: PackageWireEntry[] = [];
  let weight = 0;
  const flush = async () => {
    if (!batch.length) return;
    const acknowledgement = new Promise<void>(resolve => port.once("message", () => resolve()));
    port.postMessage({ entries: batch });
    batch = [];
    weight = 0;
    await acknowledgement;
  };
  const emit = async (entry: PackageWireEntry) => {
    batch.push(entry);
    weight += entry.kind === "string" ? entry.value.length * 2 : 256;
    if (weight >= 256 * 1024 || batch.length >= 256) await flush();
  };
  const visit = async (value: unknown, path: Array<string | number>): Promise<void> => {
    if (path.length > 64) throw new Error("Agent package nesting exceeds 64 levels");
    if (typeof value === "string") {
      await emit({ kind: "value", path, value: "" });
      for (let offset = 0; offset < value.length; offset += 32 * 1024) {
        await emit({ kind: "string", path, value: value.slice(offset, offset + 32 * 1024) });
      }
    } else if (value && typeof value === "object") {
      await emit({ kind: Array.isArray(value) ? "array" : "object", path });
      for (const key of Object.keys(value)) {
        await visit((value as Record<string, unknown>)[key], [...path, key]);
      }
    } else {
      await emit({ kind: "value", path, value });
    }
  };
  await visit({ metadata, portable, ...(canonicalPayloadHash ? { canonicalPayloadHash } : {}) }, []);
  await flush();
  port.postMessage({ done: true, memory: process.memoryUsage() });
}
void parse().catch(error => port.postMessage({ error: error instanceof Error ? error.message : String(error), statusCode: (error as {statusCode?:number})?.statusCode }));
