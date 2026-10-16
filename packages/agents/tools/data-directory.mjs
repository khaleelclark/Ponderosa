#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readSecureFile } from "@ponderosa/native-host";
import {
  AgentStore,
  CoordinationV3Store,
  createOfflineDataDirectoryBackup,
  restoreOfflineDataDirectoryBackup,
  retainChatAttachment,
  readRetainedChatAttachment,
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
} else if (command === "attachment-repair") {
  const projectId = value("--project-id");
  const conversationId = value("--chat-id");
  const eventId = value("--event-id");
  const attachmentId = value("--attachment-id");
  const backup = value("--backup");
  const reason = value("--reason");
  if (!projectId || !conversationId || !eventId || !attachmentId || !backup || !reason) {
    throw new Error("attachment-repair requires --project-id, --chat-id, --event-id, --attachment-id, --backup, and --reason; --apply explicitly authorizes the repair");
  }
  const store = new AgentStore(dataDir);
  try {
    const chat = store.getConversation(conversationId);
    const event = store.getCommunicationEvent(projectId, eventId);
    const projection = store.getCommunicationProjection(projectId, eventId, "conversation", conversationId) ??
      store.getCommunicationProjection(projectId, eventId, "collaboration_view", conversationId);
    if (!chat || chat.projectId !== projectId || !event || event.conversationId !== conversationId || !projection?.message) {
      throw new Error("Repair target is not a canonical message in a retained Chat");
    }
    const attachment = (projection.message.attachments ?? event.attachments ?? []).find(item => item.id === attachmentId);
    if (!attachment?.agentId || !attachment.sha256 || !attachment.size) throw new Error("Attachment has no verifiable canonical identity");
    const sourceDirectory = `projects/${projectId}/agents/${attachment.agentId}/attachments`;
    const source = readSecureFile({ root: backup, relativePath: `${sourceDirectory}/${attachmentId}.bin`, maxBytes: 80 * 1024 * 1024 });
    if (!source || source.length !== attachment.size || createHash("sha256").update(source).digest("hex") !== attachment.sha256) {
      throw new Error("Backup attachment bytes do not match the canonical message");
    }
    const admission = store.stateAdmission();
    let retainedRoot;
    try { retainedRoot = admission.dataDir; } finally { admission.close(); }
    const alreadyRetained = Boolean(readRetainedChatAttachment(retainedRoot, projectId, conversationId, attachment.agentId, attachmentId));
    if (args.includes("--apply")) retainChatAttachment({
      dataDir: retainedRoot, sourceRoot: backup, sourceDirectory, projectId, conversationId, eventId, attachment,
      repairSource: JSON.stringify({ backup, reason }),
    });
    console.log(JSON.stringify({ status: args.includes("--apply") ? "retained" : "preview", projectId, conversationId, eventId, attachmentId, size: attachment.size, sha256: attachment.sha256, alreadyRetained }));
  } finally { store.close(); }
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
      SELECT activation.project_id, runtime.payload_json AS runtime_payload_json
      FROM activation_sources source
      JOIN agent_activations activation ON activation.id = source.activation_id
      JOIN runtime_communications runtime ON runtime.id = source.source_id
        AND runtime.project_id = activation.project_id
      WHERE source.activation_id = ? AND source.source_kind = 'communication'
    `).all(activationId);
    const runtimePayload = sources.length === 1
      ? JSON.parse(sources[0].runtime_payload_json)
      : undefined;
    const canonicalEventId = runtimePayload?.communication?.eventId;
    const source = typeof canonicalEventId === "string" && canonicalEventId
      ? store.getCommunicationEvent(sources[0].project_id, canonicalEventId)
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
  throw new Error("usage: data-directory.mjs backup|restore|attachment-repair|outbox-list|outbox-requeue --data-dir PATH [command options]");
}
