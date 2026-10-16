#!/usr/bin/env node
// Explicit offline operation: reserve new projection identities, never rewrite events or retained artifacts.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { admitDataDirectory } from "../dist/state-admission.js";
import { artifactSequencePath, readArtifactSequenceReservation, retainedArtifactHighWater } from "../dist/artifact-sequence.js";
import { initProjectionState, projectEvent } from "../dist/projectors.js";
import { managedArtifactContentPath } from "../dist/paths.js";
import { writeJson } from "../dist/store-filesystem.js";
import { recoveredRuntimeProcessHandle } from "../../engines/dist/index.js";
const { values } = parseArgs({ options: {
  "data-dir": { type: "string" }, "project-id": { type: "string" }, "agent-id": { type: "string" },
  "from-seq": { type: "string" }, "expected-log-sha256": { type: "string" }, apply: { type: "boolean", default: false },
} });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const projectId = values["project-id"], agentId = values["agent-id"], fromSeq = Number(values["from-seq"]);
if (!values["data-dir"] || !uuid.test(projectId ?? "") || !uuid.test(agentId ?? "") ||
    !Number.isSafeInteger(fromSeq) || fromSeq < 1 || !/^[a-f0-9]{64}$/u.test(values["expected-log-sha256"] ?? "")) {
  throw new Error("require --data-dir, --project-id, --agent-id, --from-seq and --expected-log-sha256; --apply writes the reservation");
}
if (!existsSync(join(values["data-dir"], ".ponderosa-layout-version"))) throw new Error("offline repair requires an existing current data root");
const owner = admitDataDirectory(values["data-dir"]);
try {
  const root = owner.dataDir, db = owner.client;
  for (const row of db.prepare("SELECT pid, pgid, birth_marker FROM provider_process_authority WHERE agent_id=?").all(agentId)) {
    if (recoveredRuntimeProcessHandle({ pid: row.pid, pgid: row.pgid, birthMarker: row.birth_marker }).isAlive()) {
      throw new Error("exact Agent still retains a live provider process; recovery requires observed exit");
    }
  }
  const dir = join(root, "projects", projectId, "agents", agentId);
  const metadata = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8"));
  if (metadata.id !== agentId || metadata.projectId !== projectId) throw new Error("Agent ownership mismatch");
  // ponytail: this operator repair is bounded to 32 MiB logs/catalogs; larger recovery needs streaming qualification.
  const boundedRead = file => {
    if (statSync(file).size > 32 * 1024 * 1024) throw new Error("offline repair read limit exceeded");
    return readFileSync(file);
  };
  const log = boundedRead(join(dir, "events.jsonl"));
  const logSha256 = createHash("sha256").update(log).digest("hex");
  if (logSha256 !== values["expected-log-sha256"] || !log.toString("utf8").endsWith("\n")) throw new Error("canonical log changed or has an incomplete tail; bytes preserved");
  const records = log.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  if (records.some((row, i) => !Number.isSafeInteger(row.seq) || row.seq < 1 || (i && row.seq <= records[i - 1].seq))) throw new Error("invalid canonical sequence order");
  const prior = readArtifactSequenceReservation(root, projectId, agentId);
  let reservation = prior;
  if (prior) {
    if (prior.fromSeq !== fromSeq) throw new Error("reservation already belongs to a different canonical boundary");
  } else {
    const head = db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM events WHERE agent_id=?").get(agentId).seq;
    if (head >= fromSeq) throw new Error("repair boundary is already projected");
    // Failed startup/shutdown rebuild can roll the entire Project back. The
    // canonical first collision, not a now-empty projection head, owns repair.
    let state = initProjectionState(metadata.activeEngine), collision;
    const earlierArtifacts = [];
    for (const row of records) {
      const result = projectEvent(agentId, state, row); state = result.state;
      if (row.seq === fromSeq) collision = result.ops.find(op => op.kind === "insert_artifact" && op.content !== undefined);
      if (row.seq < fromSeq) earlierArtifacts.push(...result.ops.filter(op => op.kind === "insert_artifact" && op.content !== undefined));
    }
    if (!collision) throw new Error("repair boundary does not generate a deterministic content artifact");
    const catalog = boundedRead(join(root, "projects", projectId, "artifacts", "artifacts.jsonl"));
    const artifacts = catalog.toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === "created").map(row => row.artifact);
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    for (const op of earlierArtifacts) {
      const retained = artifacts.find(item => item.id === op.row.id);
      if (retained && (retained.sha256 !== hash(op.content) || retained.createdAt !== op.row.createdAt ||
          (retained.executionId ?? null) !== op.row.executionId)) throw new Error("an earlier immutable artifact collision requires repair first");
    }
    const old = artifacts.find(item => item.id === collision.row.id);
    const oldBytes = boundedRead(managedArtifactContentPath(root, projectId, collision.row.id));
    if (!old || old.size !== oldBytes.length || old.sha256 !== hash(oldBytes) || old.sha256 === hash(collision.content)) throw new Error("retained immutable collision evidence does not match");
    const offset = retainedArtifactHighWater(agentId, artifacts.map(item => item.id));
    if (!offset || !Number.isSafeInteger(offset + records.at(-1).seq)) throw new Error("artifact reservation exhausted");
    reservation = { fromSeq, offset };
    if (values.apply) writeJson(artifactSequencePath(root, projectId, agentId), reservation);
  }
  console.log(JSON.stringify({ agentId, projectId, generationId: owner.generationId, logSha256, reservation, applied: values.apply, replayed: Boolean(prior) }));
} finally { owner.close(); }
