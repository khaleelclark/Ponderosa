import type { AssetDto } from "@ponderosa/core";
import type Database from "better-sqlite3";
import { stableJson } from "./coordination-v3-canonical-json.js";
import {
  RUNTIME_MAX_ATTACHMENTS_PER_MESSAGE,
  RUNTIME_MAX_MESSAGE_ATTACHMENT_BYTES,
  type RuntimeDispatchAttachmentV3,
  UUID_PATTERN,
  runtimeCanonicalAttachmentsAreValid,
  runtimeDispatchAttachmentsAreValid,
} from "./coordination-v3-runtime-validation.js";
import type {
  CoordinationV3StoreOptions,
  RuntimeAttachmentAuthorityV3,
  RuntimeAttachmentReservationReceiptV3,
} from "./coordination-v3-types.js";

type RuntimeAttachmentAuthorityOptions = Pick<CoordinationV3StoreOptions, "attachmentAuthority">;
type RuntimeAttachmentBinding = {
  projectId: string;
  agentId: string;
  attachmentId: string;
  contentHash: string;
  byteLength: number;
};

export class CoordinationV3RuntimeAttachmentAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: RuntimeAttachmentAuthorityOptions,
  ) {}

  bindRuntimeAttachments(
    projectId: string,
    payloadValue: unknown,
    activationAgentIds: string[],
  ): { payload: unknown; bindings: RuntimeAttachmentBinding[] } {
    const payload = payloadValue && typeof payloadValue === "object" && !Array.isArray(payloadValue)
      ? payloadValue as Record<string, unknown>
      : undefined;
    if (!payload) return { payload: payloadValue, bindings: [] };
    const embedded = payload.communication
      && typeof payload.communication === "object"
      && !Array.isArray(payload.communication)
      ? payload.communication as Record<string, unknown>
      : undefined;
    const communication = embedded
      ?? (Object.prototype.hasOwnProperty.call(payload, "schemaVersion") ? payload : undefined);
    const dispatch = payload.dispatch
      && typeof payload.dispatch === "object"
      && !Array.isArray(payload.dispatch)
      ? payload.dispatch as Record<string, unknown>
      : undefined;
    const hasCanonicalAttachments = Boolean(
      communication && Object.prototype.hasOwnProperty.call(communication, "attachments"),
    );
    const hasTopLevelAttachments = Boolean(
      dispatch && Object.prototype.hasOwnProperty.call(dispatch, "attachments"),
    );
    const recipients = dispatch && Object.prototype.hasOwnProperty.call(dispatch, "recipients")
      ? dispatch.recipients
      : undefined;
    const hasRecipientAttachments = Array.isArray(recipients) && recipients.some((candidate) =>
      candidate
      && typeof candidate === "object"
      && !Array.isArray(candidate)
      && Object.prototype.hasOwnProperty.call(candidate, "attachments"));
    if (!hasCanonicalAttachments && !hasTopLevelAttachments && !hasRecipientAttachments) {
      return { payload: payloadValue, bindings: [] };
    }

    if (hasCanonicalAttachments && !runtimeCanonicalAttachmentsAreValid(communication!.attachments)) {
      throw new Error("runtime communication attachments are invalid");
    }
    if (hasTopLevelAttachments && !runtimeDispatchAttachmentsAreValid(dispatch!.attachments)) {
      throw new Error("runtime communication attachments are invalid");
    }
    if (recipients !== undefined && !Array.isArray(recipients)) {
      throw new Error("runtime communication attachments are invalid");
    }

    const authority = this.options.attachmentAuthority;
    const canonicalAttachments = hasCanonicalAttachments
      ? communication!.attachments as AssetDto[]
      : [];
    const canonicalOwnerById = new Map(
      canonicalAttachments.map((attachment) => [attachment.id, attachment.agentId] as const),
    );
    const targets = [...new Set(activationAgentIds)];
    const topLevelAttachments = hasTopLevelAttachments
      ? dispatch!.attachments as RuntimeDispatchAttachmentV3[]
      : [];
    const canonicalTargets = [...new Set(topLevelAttachments.flatMap((attachment) => {
      const owner = canonicalOwnerById.get(attachment.id);
      return owner ? [owner] : [];
    }))];
    const topLevelOwner = topLevelAttachments.length === 0
      ? undefined
      : targets.length === 1
        ? targets[0]
        : targets.length === 0
          && canonicalTargets.length === 1
          && topLevelAttachments.every((attachment) => canonicalOwnerById.has(attachment.id))
          ? canonicalTargets[0]
          : undefined;
    if (topLevelAttachments.length > 0 && !topLevelOwner) {
      throw new Error("runtime communication attachment owner is ambiguous");
    }

    // Bound structural work before the authority resolver opens or hashes any
    // file. Canonical and dispatch appearances of the same Project+owner+ID are
    // one candidate; contradictory owners and dispatch duplicates fail closed.
    const candidateKeys = new Set<string>();
    const ownerById = new Map<string, string>();
    const dispatchIds = new Set<string>();
    const addCandidate = (
      agentId: string,
      attachmentId: string,
      dispatchAppearance: boolean,
    ): void => {
      if (dispatchAppearance) {
        if (dispatchIds.has(attachmentId)) {
          throw new Error("runtime communication attachments are invalid");
        }
        dispatchIds.add(attachmentId);
      }
      const priorOwner = ownerById.get(attachmentId);
      if (priorOwner !== undefined && priorOwner !== agentId) {
        throw new Error(
          "runtime communication attachment identity conflicts across canonical and dispatch appearances",
        );
      }
      ownerById.set(attachmentId, agentId);
      candidateKeys.add(`${projectId}\0${agentId}\0${attachmentId}`);
      if (candidateKeys.size > RUNTIME_MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new Error("runtime communication attachments are invalid");
      }
    };
    for (const attachment of canonicalAttachments) {
      addCandidate(attachment.agentId, attachment.id, false);
    }
    for (const attachment of topLevelAttachments) {
      addCandidate(topLevelOwner!, attachment.id, true);
    }
    if (Array.isArray(recipients)) {
      for (const candidate of recipients) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          if (hasRecipientAttachments) {
            throw new Error("runtime communication attachments are invalid");
          }
          continue;
        }
        const recipient = candidate as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(recipient, "attachments")) continue;
        if (
          typeof recipient.agentId !== "string"
          || !UUID_PATTERN.test(recipient.agentId)
          || !runtimeDispatchAttachmentsAreValid(recipient.attachments)
        ) {
          throw new Error("runtime communication attachments are invalid");
        }
        for (const attachment of recipient.attachments as RuntimeDispatchAttachmentV3[]) {
          addCandidate(recipient.agentId, attachment.id, true);
        }
      }
    }

    const resolvedByOwner = new Map<string, RuntimeAttachmentAuthorityV3>();
    const meaningById = new Map<string, string>();
    const resolveAuthority = (
      agentId: string,
      attachmentId: string,
    ): RuntimeAttachmentAuthorityV3 => {
      const key = `${projectId}\0${agentId}\0${attachmentId}`;
      const cached = resolvedByOwner.get(key);
      if (cached) return cached;
      const resolved = authority?.resolve(projectId, agentId, attachmentId);
      if (
        !resolved
        || resolved.contentHash !== resolved.attachment.sha256
        || resolved.byteLength !== resolved.attachment.size
        || !/^[a-f0-9]{64}$/.test(resolved.contentHash)
        || !resolved.localPath
      ) {
        throw new Error("runtime communication attachment authority mismatch");
      }
      const meaning = stableJson({
        projectId,
        agentId,
        attachment: resolved.attachment,
        contentHash: resolved.contentHash,
        byteLength: resolved.byteLength,
      });
      const priorMeaning = meaningById.get(attachmentId);
      if (priorMeaning !== undefined && priorMeaning !== meaning) {
        throw new Error(
          "runtime communication attachment identity conflicts across canonical and dispatch appearances",
        );
      }
      meaningById.set(attachmentId, meaning);
      resolvedByOwner.set(key, resolved);
      return resolved;
    };
    const resolveCanonical = (attachment: AssetDto): AssetDto => {
      const resolved = resolveAuthority(attachment.agentId, attachment.id);
      if (stableJson(resolved.attachment) !== stableJson(attachment)) {
        throw new Error("runtime communication attachment authority mismatch");
      }
      return resolved.attachment;
    };
    const resolveSnapshot = (
      attachment: RuntimeDispatchAttachmentV3,
      agentId: string,
    ): RuntimeDispatchAttachmentV3 => {
      const resolved = resolveAuthority(agentId, attachment.id);
      if (
        attachment.name !== resolved.attachment.name
        || attachment.mediaType !== resolved.attachment.mediaType
        || attachment.size !== resolved.attachment.size
        || (attachment.sha256 !== undefined && attachment.sha256 !== resolved.contentHash)
        || (attachment.localPath !== undefined && attachment.localPath !== resolved.localPath)
      ) {
        throw new Error("runtime communication attachment authority mismatch");
      }
      return {
        id: resolved.attachment.id,
        name: resolved.attachment.name,
        mediaType: resolved.attachment.mediaType,
        size: resolved.attachment.size,
        sha256: resolved.contentHash,
        localPath: resolved.localPath,
      };
    };

    let nextCommunication = communication;
    if (hasCanonicalAttachments) {
      nextCommunication = {
        ...communication!,
        attachments: (communication!.attachments as AssetDto[]).map(resolveCanonical),
      };
    }
    let nextDispatch = dispatch;
    if (dispatch) {
      nextDispatch = { ...dispatch };
      if (hasTopLevelAttachments) {
        nextDispatch.attachments = topLevelAttachments.length
          ? topLevelAttachments.map((attachment) => resolveSnapshot(attachment, topLevelOwner!))
          : [];
      }
      if (Array.isArray(recipients)) {
        nextDispatch.recipients = recipients.map((candidate) => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            if (hasRecipientAttachments) {
              throw new Error("runtime communication attachments are invalid");
            }
            return candidate;
          }
          const recipient = candidate as Record<string, unknown>;
          if (!Object.prototype.hasOwnProperty.call(recipient, "attachments")) return candidate;
          if (
            typeof recipient.agentId !== "string"
            || !UUID_PATTERN.test(recipient.agentId)
            || !runtimeDispatchAttachmentsAreValid(recipient.attachments)
          ) {
            throw new Error("runtime communication attachments are invalid");
          }
          return {
            ...recipient,
            attachments: (recipient.attachments as RuntimeDispatchAttachmentV3[])
              .map((attachment) => resolveSnapshot(attachment, recipient.agentId as string)),
          };
        });
      }
    }

    const resolvedAttachments = [...resolvedByOwner.values()];
    if (
      resolvedAttachments.length > RUNTIME_MAX_ATTACHMENTS_PER_MESSAGE
      || resolvedAttachments.reduce((total, resolved) => total + resolved.byteLength, 0)
        > RUNTIME_MAX_MESSAGE_ATTACHMENT_BYTES
    ) {
      throw new Error("runtime communication attachments are invalid");
    }
    const bindings = resolvedAttachments.map((resolved) => ({
      projectId,
      agentId: resolved.attachment.agentId,
      attachmentId: resolved.attachment.id,
      contentHash: resolved.contentHash,
      byteLength: resolved.byteLength,
    }));
    if (embedded) {
      return {
        payload: {
          ...payload,
          ...(nextCommunication ? { communication: nextCommunication } : {}),
          ...(nextDispatch ? { dispatch: nextDispatch } : {}),
        },
        bindings,
      };
    }
    if (communication === payload) return { payload: nextCommunication, bindings };
    return {
      payload: nextDispatch ? { ...payload, dispatch: nextDispatch } : payloadValue,
      bindings,
    };
  }

  compensationReceiptForCommittedRuntimeCommunication(
    receipt: RuntimeAttachmentReservationReceiptV3,
    committed: { project_id: string; payload_hash: string; payload_json: string } | undefined,
    expectedProjectId: string,
    expectedPayloadHash: string,
  ): RuntimeAttachmentReservationReceiptV3 | undefined {
    if (!committed) return receipt;
    if (
      committed.project_id === expectedProjectId
      && committed.payload_hash === expectedPayloadHash
    ) {
      return undefined;
    }
    try {
      const activationAgents = this.sqlite.prepare(`
        SELECT activation.agent_id agentId
        FROM agent_activations activation
        JOIN activation_sources source ON source.activation_id = activation.id
        WHERE source.source_kind = 'communication' AND source.source_id = ?
          AND activation.project_id = ?
        ORDER BY activation.created_at, activation.id
      `).all(receipt.communicationId, committed.project_id) as Array<{ agentId: string }>;
      const requiredBindings = this.bindRuntimeAttachments(
        committed.project_id,
        JSON.parse(committed.payload_json) as unknown,
        activationAgents.map((row) => row.agentId),
      ).bindings;
      const requiredKeys = new Set(requiredBindings.map((binding) => stableJson(binding)));
      const unusedBindings = receipt.bindings.filter((binding) => !requiredKeys.has(stableJson({
        projectId: binding.projectId,
        agentId: binding.agentId,
        attachmentId: binding.attachmentId,
        contentHash: binding.contentHash,
        byteLength: binding.byteLength,
      })));
      return unusedBindings.length ? { ...receipt, bindings: unusedBindings } : undefined;
    } catch {
      // A committed payload whose attachment requirements cannot be proven
      // must not inherit authority from a different failed publication.
      return receipt;
    }
  }

  revalidateRuntimeAttachments(
    projectId: string,
    bindings: RuntimeAttachmentBinding[],
  ): void {
    if (!bindings.length) return;
    const authority = this.options.attachmentAuthority;
    if (!authority) throw new Error("runtime communication attachment authority mismatch");
    for (const binding of bindings) {
      const resolved = authority.resolve(projectId, binding.agentId, binding.attachmentId);
      if (
        !resolved
        || binding.projectId !== projectId
        || resolved.attachment.agentId !== binding.agentId
        || resolved.attachment.id !== binding.attachmentId
        || resolved.contentHash !== binding.contentHash
        || resolved.byteLength !== binding.byteLength
        || resolved.attachment.sha256 !== binding.contentHash
        || resolved.attachment.size !== binding.byteLength
      ) {
        throw new Error(
          "runtime communication attachment authority mismatch after scheduler commit",
        );
      }
    }
  }
}
