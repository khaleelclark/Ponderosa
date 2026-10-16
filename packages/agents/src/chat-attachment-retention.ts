import { createHash, randomUUID } from "node:crypto";
import type { CommunicationAttachmentDto, CommunicationEvent, CommunicationProjection } from "@ponderosa/core";
import { ensureSecureDirectory, listSecureDirectory, readSecureFile, secureDirectoryIdentity, writeSecureFileAtomic } from "@ponderosa/native-host";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_BYTES = 80 * 1024 * 1024;
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
interface RetentionRecord {
  version: 1;
  projectId: string;
  conversationId: string;
  eventId: string;
  attachment: CommunicationAttachmentDto & { agentId: string; sha256: string; size: number };
  previewHash?: string;
  retainedAt: string;
  repairSource?: string;
}

function directory(projectId: string, conversationId: string): string {
  if (!UUID.test(projectId) || !UUID.test(conversationId)) throw new Error("Invalid retained attachment scope");
  return `projects/${projectId}/conversations/${conversationId}/retained-attachments`;
}
function leaf(ownerId: string, assetId: string): string {
  if (!UUID.test(ownerId) || !UUID.test(assetId)) throw new Error("Invalid retained attachment identity");
  return `${ownerId}-${assetId}`;
}

export function readRetainedChatAttachment(dataDir: string, projectId: string, conversationId: string, ownerId: string, assetId: string) {
  try {
    const relative = directory(projectId, conversationId);
    const prefix = leaf(ownerId, assetId);
    const raw = readSecureFile({ root: dataDir, relativePath: `${relative}/${prefix}.json`, maxBytes: 32 * 1024 });
    if (!raw) return undefined;
    const record = JSON.parse(raw.toString("utf8")) as RetentionRecord;
    if (record.version !== 1 || record.projectId !== projectId || record.conversationId !== conversationId ||
        record.attachment?.agentId !== ownerId || record.attachment.id !== assetId ||
        !/^[a-f0-9]{64}$/u.test(record.attachment.sha256) || !Number.isSafeInteger(record.attachment.size) ||
        record.attachment.size < 1 || record.attachment.size > MAX_BYTES) return undefined;
    return record;
  } catch { return undefined; }
}

export function retainedChatAttachmentContent(dataDir: string, projectId: string, conversationId: string, ownerId: string, assetId: string, preview: boolean) {
  const record = readRetainedChatAttachment(dataDir, projectId, conversationId, ownerId, assetId);
  if (!record || (preview && !record.previewHash)) return undefined;
  const relative = directory(projectId, conversationId);
  const body = readSecureFile({ root: dataDir, relativePath: `${relative}/${leaf(ownerId, assetId)}.${preview ? "preview.png" : "bin"}`, maxBytes: preview ? 8 * 1024 * 1024 : MAX_BYTES });
  if (!body || hash(body) !== (preview ? record.previewHash : record.attachment.sha256) ||
      (!preview && body.length !== record.attachment.size)) return undefined;
  return { record, body };
}

/** Copy first, verify, then publish the durable mapping. Source cleanup happens
 * only after this returns; any interrupted phase is safe to repeat. */
export function retainChatAttachment(input: {
  dataDir: string; sourceRoot?: string; sourceDirectory: string;
  projectId: string; conversationId: string; eventId: string;
  attachment: CommunicationAttachmentDto; repairSource?: string;
}): void {
  const { dataDir, projectId, conversationId, eventId, attachment } = input;
  if (!attachment.agentId || !attachment.sha256 || !attachment.size) throw new Error("Sent attachment has no verifiable identity");
  const relative = directory(projectId, conversationId);
  const prefix = leaf(attachment.agentId, attachment.id);
  const existing = readRetainedChatAttachment(dataDir, projectId, conversationId, attachment.agentId, attachment.id);
  if (existing) {
    if (existing.attachment.sha256 !== attachment.sha256 || existing.attachment.size !== attachment.size ||
        !retainedChatAttachmentContent(dataDir, projectId, conversationId, attachment.agentId, attachment.id, false) ||
        (existing.previewHash && !retainedChatAttachmentContent(dataDir, projectId, conversationId, attachment.agentId, attachment.id, true))) {
      throw new Error("Retained Chat attachment failed verification; source cleanup remains pending");
    }
    return;
  }
  const rootIdentity = secureDirectoryIdentity({ root: dataDir });
  if (!rootIdentity) throw new Error("Attachment retention storage is unavailable");
  ensureSecureDirectory({ root: dataDir, relativePath: relative });
  const destinationIdentity = secureDirectoryIdentity({ root: dataDir, relativePath: relative });
  const sourceRoot = input.sourceRoot ?? dataDir;
  const sourceIdentity = secureDirectoryIdentity({ root: sourceRoot, relativePath: input.sourceDirectory });
  if (!destinationIdentity || !sourceIdentity) throw new Error("Attachment source is unavailable; deletion cleanup remains pending");
  const check = () => {
    if (secureDirectoryIdentity({ root: dataDir }) !== rootIdentity ||
        secureDirectoryIdentity({ root: dataDir, relativePath: relative }) !== destinationIdentity ||
        secureDirectoryIdentity({ root: sourceRoot, relativePath: input.sourceDirectory }) !== sourceIdentity) {
      throw new Error("Attachment storage changed; deletion cleanup remains pending");
    }
  };
  const body = readSecureFile({ root: sourceRoot, relativePath: `${input.sourceDirectory}/${attachment.id}.bin`, maxBytes: MAX_BYTES });
  if (!body || body.length !== attachment.size || hash(body) !== attachment.sha256) {
    throw new Error("Sent attachment bytes are missing or changed; deletion cleanup remains pending");
  }
  const preview = readSecureFile({ root: sourceRoot, relativePath: `${input.sourceDirectory}/${attachment.id}.preview.png`, maxBytes: 8 * 1024 * 1024 });
  if (attachment.previewUrl && !preview) throw new Error("Sent image preview is missing; deletion cleanup remains pending");
  const publish = (name: string, bytes: Buffer) => {
    check();
    const prior = readSecureFile({ root: dataDir, relativePath: `${relative}/${name}`, maxBytes: MAX_BYTES });
    if (prior) {
      if (!prior.equals(bytes)) throw new Error("Retained attachment conflicts with an existing copy");
    } else writeSecureFileAtomic({ root: dataDir, relativeDirectory: relative, leaf: name, temporaryLeaf: `.${randomUUID()}.tmp`, body: bytes });
    check();
    const verified = readSecureFile({ root: dataDir, relativePath: `${relative}/${name}`, maxBytes: MAX_BYTES });
    if (!verified?.equals(bytes)) throw new Error("Retained attachment publication could not be verified");
  };
  publish(`${prefix}.bin`, body);
  if (preview) publish(`${prefix}.preview.png`, preview);
  const record: RetentionRecord = {
    version: 1, projectId, conversationId, eventId,
    attachment: { ...attachment, agentId: attachment.agentId, sha256: attachment.sha256, size: attachment.size },
    ...(preview ? { previewHash: hash(preview) } : {}),
    retainedAt: new Date().toISOString(),
    ...(input.repairSource ? { repairSource: input.repairSource } : {}),
  };
  publish(`${prefix}.json`, Buffer.from(JSON.stringify(record)));
}

export function retainAgentChatAttachments(input: {
  dataDir: string; projectId: string; agentId: string; sourceDirectory: string;
  events: readonly CommunicationEvent[]; projections: readonly CommunicationProjection[];
  chatExists(id: string): boolean;
  isManagedAttachment?(attachment: CommunicationAttachmentDto): boolean;
}): void {
  const projections = new Map(input.projections.filter(item => item.message && (item.surface === "conversation" || item.surface === "collaboration_view")).map(item => [`${item.eventId}:${item.projectionKey}`, item]));
  for (const event of input.events) {
    if (!event.conversationId || event.projectId !== input.projectId || !input.chatExists(event.conversationId)) continue;
    const projection = projections.get(`${event.eventId}:${event.conversationId}`);
    // Only a canonical message actually placed in a surviving Chat can retain
    // media. Runtime reservations and private audit-only copies grant no claim.
    if (!projection?.message) continue;
    const attachments = projection.message.attachments ?? event.attachments ?? [];
    for (const attachment of attachments) {
      if (attachment.agentId !== input.agentId) continue;
      // Project-managed bytes are outside Agent attachment storage and survive
      // its removal without a second copy in the Chat retention directory.
      if (input.isManagedAttachment?.(attachment)) continue;
      retainChatAttachment({ ...input, conversationId: event.conversationId, eventId: event.eventId, attachment });
    }
  }
}

export function presentRetainedChatAttachment(dataDir: string, projectId: string, conversationId: string, attachment: CommunicationAttachmentDto, ownerExists: boolean): CommunicationAttachmentDto {
  if (!attachment.agentId) return attachment;
  const retained = readRetainedChatAttachment(dataDir, projectId, conversationId, attachment.agentId, attachment.id);
  if (!retained) return ownerExists ? attachment : { ...attachment, unavailable: true, url: undefined, previewUrl: undefined, downloadUrl: undefined };
  if (attachment.sha256 !== retained.attachment.sha256 || attachment.size !== retained.attachment.size) return { ...attachment, unavailable: true, url: undefined, previewUrl: undefined, downloadUrl: undefined };
  const prefix = leaf(attachment.agentId, attachment.id);
  const entries = listSecureDirectory({ root: dataDir, relativePath: directory(projectId, conversationId) });
  const original = entries?.find(entry => entry.name === `${prefix}.bin` && entry.kind === "file");
  const preview = retained.previewHash ? entries?.find(entry => entry.name === `${prefix}.preview.png` && entry.kind === "file") : undefined;
  if (original?.size !== attachment.size || (retained.previewHash && !preview)) return { ...attachment, unavailable: true, url: undefined, previewUrl: undefined, downloadUrl: undefined };
  const base = `/api/conversations/${conversationId}/retained-attachments/${attachment.agentId}/${attachment.id}`;
  return { ...attachment, unavailable: false, url: retained.previewHash ? `${base}/preview` : `${base}/download`,
    previewUrl: retained.previewHash ? `${base}/preview` : undefined, downloadUrl: `${base}/download` };
}
