import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "@ponderosa/native-host/fs";
import { AgentPackageJsonParser, agentPackageJsonUtf8Bytes, AGENT_PACKAGE_MAX_AGENTS, AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_METADATA_MAX_BYTES, AGENT_PACKAGE_LIMIT_LABEL } from "@ponderosa/core";
import type { PackageWireEntry } from "./agent-package-codec.js";
import { stableJsonParts } from "@ponderosa/agents/canonical-json";
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
  const parser = new AgentPackageJsonParser(), decoder = new TextDecoder("utf-8", { fatal: true });
  let metadata: Record<string, unknown> = {};
  let header = Buffer.alloc(0), headerDone = input.packageOnly || input.jsonEnvelope, rawBytes = 0;
  for await (const chunk of createReadStream(input.pathname, { highWaterMark: 256 * 1024 })) {
    let raw = chunk as Buffer;
    if (!headerDone) {
      const newline = raw.indexOf(0x0a);
      if (header.length + (newline < 0 ? raw.length : newline) > AGENT_PACKAGE_METADATA_MAX_BYTES) throw new Error("Agent package upload metadata is invalid");
      if (newline < 0) { header = Buffer.concat([header, raw]); continue; }
      header = Buffer.concat([header, raw.subarray(0, newline)]);
      metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header));
      raw = raw.subarray(newline + 1); headerDone = true;
    }
    rawBytes += raw.length;
    if (rawBytes > AGENT_PACKAGE_MAX_BYTES + (input.jsonEnvelope ? AGENT_PACKAGE_METADATA_MAX_BYTES + 12 : 0)) throw new Error(`Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL}`);
    parser.write(decoder.decode(raw, { stream: true }));
  }
  if (!headerDone) throw new Error("Agent package upload metadata is invalid");
  parser.write(decoder.decode());
  let portable: unknown = parser.end();
  let canonicalPayloadHash: string | undefined;
  if (input.jsonEnvelope) {
    const envelope = validatedObject(portable, "Agent import request");
    exactObjectFields(envelope, ["package", "conversationId", "engineMapping", "acknowledgeElevatedManagementPermissions", "chatInstructionsResolution", "outputRoleReviewId", "accessSettingsResolution", "workingCopyMode", "workingFilesDestination", "workingRootDestinations", "workingFilesActivation", "reviewedUserDataActivation", "reviewedMetadataActivation"], "Agent import request");
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
      ...(metadata.accessSettingsResolution?{accessSettingsResolution:metadata.accessSettingsResolution}:{}),
      ...(metadata.reviewedUserDataActivation?{reviewedUserDataActivation:metadata.reviewedUserDataActivation}:{}),
      ...(metadata.reviewedMetadataActivation!==undefined?{reviewedMetadataActivation:metadata.reviewedMetadataActivation}:{}),
      ...(metadata.workingFilesActivation?{workingFilesActivation:metadata.workingFilesActivation}:{}),
      ...(metadata.workingRootDestinations?{workingRootDestinations:metadata.workingRootDestinations}:{}),
      ...(metadata.workingFilesDestination?{workingFilesDestination:metadata.workingFilesDestination}:{}),
      ...(metadata.workingCopyMode?{workingCopyMode:metadata.workingCopyMode}:{}),
      ...(metadata.outputRoleReviewId ? {outputRoleReviewId:metadata.outputRoleReviewId} : {}),
      ...(metadata.chatInstructionsResolution ? { chatInstructionsResolution: metadata.chatInstructionsResolution } : {}),
      acknowledgeElevatedManagementPermissions: metadata.acknowledgeElevatedManagementPermissions ?? false,
    }, { maxDepth: 64, maxNodes: AGENT_PACKAGE_MAX_BYTES })) hash.update(part);
    canonicalPayloadHash = hash.digest("hex");
  }
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
