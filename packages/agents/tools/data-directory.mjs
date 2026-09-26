#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  AgentStore,
  CoordinationV3Store,
  createOfflineDataDirectoryBackup,
  restoreOfflineDataDirectoryBackup,
} from "@ponderosa/agents";

const [command, ...args] = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dataDir = value("--data-dir");
if (!dataDir) throw new Error("--data-dir is required");

if (command === "backup") {
  const output = value("--output");
  if (!output) throw new Error("--output is required");
  const externalProjects = value("--external-projects");
  if (externalProjects !== "copy" && externalProjects !== "exclude") {
    throw new Error("--external-projects must be explicitly set to copy or exclude");
  }
  const manifest = createOfflineDataDirectoryBackup(dataDir, output, { externalProjects });
  console.log(JSON.stringify({ status: "created", output, files: manifest.entries.filter(entry => entry.type === "file").length }));
} else if (command === "restore") {
  const backup = value("--backup");
  if (!backup) throw new Error("--backup is required");
  const manifest = restoreOfflineDataDirectoryBackup(backup, dataDir, {
    restoreExternalProjects: args.includes("--restore-external-projects"),
    externalRootParent: value("--external-project-root"),
  });
  console.log(JSON.stringify({ status: "restored", dataDir, files: manifest.entries.filter(entry => entry.type === "file").length }));
} else if (command === "outbox-list") {
  const store = new AgentStore(dataDir);
  try {
    const rows = store.sqlite.prepare(`
      SELECT id, activation_id, event_kind, attempts, last_error, dead_lettered_at
      FROM activation_outbox WHERE processed_at IS NULL AND dead_lettered_at IS NOT NULL
      ORDER BY id LIMIT 100
    `).all();
    console.log(JSON.stringify({ status: "dead_letters", rows }));
  } finally {
    store.close();
  }
} else if (command === "outbox-requeue") {
  const id = Number(value("--outbox-id"));
  const activationId = value("--activation-id");
  const expectedError = value("--expected-error");
  const payloadFile = value("--payload-file");
  const reason = value("--reason");
  if (!Number.isSafeInteger(id) || id < 1 || !activationId || !expectedError || !payloadFile || !reason) {
    throw new Error("outbox-requeue requires --outbox-id, --activation-id, --expected-error, --payload-file, and --reason");
  }
  const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
  const store = new AgentStore(dataDir);
  try {
    const revision = payload?.revision;
    const sources = store.sqlite.prepare(`
      SELECT source.source_id, activation.project_id
      FROM activation_sources source
      JOIN agent_activations activation ON activation.id = source.activation_id
      WHERE source.activation_id = ? AND source.source_kind = 'communication'
    `).all(activationId);
    const source = sources.length === 1
      ? store.getCommunicationEvent(sources[0].project_id, sources[0].source_id)
      : undefined;
    if (!source || source.eventId !== revision?.targetEventId ||
        source.projectId !== revision.projectId ||
        source.conversationId !== revision.conversationId ||
        source.conversationId !== payload?.conversationId ||
        source.sender.kind !== "user" || revision.sender?.kind !== "user" ||
        source.sender.userId !== revision.sender.userId) {
      throw new Error("corrected revision does not identify the Activation's canonical user-owned Communication");
    }
    const coordination = new CoordinationV3Store(store.sqlite);
    coordination.requeueDeadLetteredRevision(id, activationId, expectedError, payload, source, reason);
    console.log(JSON.stringify({ status: "requeued", outboxId: id, activationId }));
  } finally {
    store.close();
  }
} else {
  throw new Error("usage: data-directory.mjs backup|restore|outbox-list|outbox-requeue --data-dir PATH [command options]");
}
