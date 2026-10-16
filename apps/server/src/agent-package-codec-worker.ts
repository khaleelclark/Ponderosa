import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, statSync } from "@ponderosa/native-host/fs";
import { AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_METADATA_MAX_BYTES, AGENT_PACKAGE_LIMIT_LABEL } from "@ponderosa/core";
import type { PackageWireEntry } from "./agent-package-codec.js";

const port = parentPort!;
const input = workerData as { pathname: string; packageOnly?: boolean };

// Only a bounded batch crosses the server event loop at once. Acknowledgement
// prevents a fast worker from queuing an entire large package in the parent.
async function parse(): Promise<void> {
  if (statSync(input.pathname).size > AGENT_PACKAGE_MAX_BYTES +
      (input.packageOnly ? 0 : AGENT_PACKAGE_METADATA_MAX_BYTES + 1)) {
    throw new Error(`Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL}`);
  }
  let body: Buffer | undefined = readFileSync(input.pathname);
  const separator = input.packageOnly ? -1 : body.indexOf(0x0a);
  if (!input.packageOnly && (separator < 1 || separator > AGENT_PACKAGE_METADATA_MAX_BYTES)) {
    throw new Error("Agent package upload metadata is invalid");
  }
  let raw: Buffer | undefined = body.subarray(separator + 1);
  if (raw.length > AGENT_PACKAGE_MAX_BYTES) throw new Error(`Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL}`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const metadata = input.packageOnly ? {} : JSON.parse(decoder.decode(body.subarray(0, separator)));
  const portable: unknown = JSON.parse(decoder.decode(raw));
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
  await visit({ metadata, portable }, []);
  await flush();
  port.postMessage({ done: true, memory: process.memoryUsage() });
}
void parse().catch(error => port.postMessage({ error: error instanceof Error ? error.message : String(error) }));
