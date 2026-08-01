import type Database from "better-sqlite3";
import { payloadHash, stableJson } from "./coordination-v3-canonical-json.js";
import type { CoordinationV3RuntimeAttachmentAuthority } from "./coordination-v3-runtime-attachment-authority.js";
import type { CoordinationV3RuntimeArtifactAuthority } from "./coordination-v3-runtime-artifact-authority.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import type {
  ActivationDispatchPolicy,
  ActivationPromptClass,
  CoordinationV3StoreOptions,
  RunAuthorizationV3,
  RuntimeAttachmentReservationReceiptV3,
  RuntimeCommunicationV3Input,
  RuntimeCommunicationV3Result,
} from "./coordination-v3-types.js";

export interface CreateActivationV3Input {
  projectId: string;
  agentId: string;
  kind: string;
  priority: number;
  dedupeKey: string;
  scopeKey: string;
  dispatchPolicy?: ActivationDispatchPolicy;
  promptClass?: ActivationPromptClass;
  payload: unknown;
  sourceKind: string;
  sourceId: string;
  now: string;
  externalIntake?: boolean;
}

/**
 * Owns the scheduler-side atomic write and filesystem-authority compensation
 * protocol for canonical runtime Communications.
 */
export class CoordinationV3RuntimeCommunicationAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: CoordinationV3StoreOptions,
    private readonly runtimeAttachmentAuthority: CoordinationV3RuntimeAttachmentAuthority,
    private readonly runtimeArtifactAuthority: CoordinationV3RuntimeArtifactAuthority,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
    private readonly requireAuthorizedRun: (
      authorization: RunAuthorizationV3,
      expectedScopeKey?: string,
    ) => void,
    private readonly requireProject: (projectId: string) => void,
    private readonly createActivation: (input: CreateActivationV3Input) => string,
  ) {}

  recordRuntimeCommunication(
    input: RuntimeCommunicationV3Input,
  ): RuntimeCommunicationV3Result {
    const now = input.now ?? new Date().toISOString();
    const activationInputs = [
      ...(input.activation ? [input.activation] : []),
      ...(input.activations ?? []),
    ];
    if (input.runAuthorization) {
      this.requireAuthorizedRun(input.runAuthorization, input.scopeKey);
    }
    this.requireProject(input.projectId);
    const preparedAttachments =
      this.runtimeAttachmentAuthority.bindRuntimeAttachments(
        input.projectId,
        input.payload,
        activationInputs.map((item) => item.agentId),
      );
    const payload = preparedAttachments.payload;
    const managedArtifactIds = this.managedArtifactIds(payload);
    const activationScopeKeys = activationInputs.map((activation) =>
      input.scopeKey ??
      this.runtimeScopeAuthority.communicationScopeKey(
        payload,
        activation.agentId,
      ));
    const artifacts = this.runtimeArtifactAuthority.resolveRuntimeArtifacts(
      input.projectId,
      input.artifacts,
      "runtime communication",
    );
    if (!this.runtimeScopeAuthority.runtimeCommunicationAuthorityAgrees({
      projectId: input.projectId,
      sender: input.sender,
      intent: input.intent,
      audience: input.audience,
      payload,
      activations: activationInputs.map((activation, index) => ({
        agentId: activation.agentId,
        kind: activation.kind,
        scopeKey: activationScopeKeys[index]!,
      })),
    })) {
      throw new Error("runtime communication authority does not agree on one Project");
    }
    const hash = payloadHash({
      projectId: input.projectId,
      sender: input.sender,
      intent: input.intent,
      audience: input.audience,
      payload,
      artifacts,
      actionable: activationInputs.length > 0,
      activations: activationInputs,
      activationScopeKeys,
    });
    const preexisting = this.sqlite.prepare(`
      SELECT project_id, payload_hash FROM runtime_communications WHERE id = ?
    `).get(input.id) as {
      project_id: string;
      payload_hash: string;
    } | undefined;
    if (
      preexisting &&
      (
        preexisting.project_id !== input.projectId ||
        preexisting.payload_hash !== hash
      )
    ) {
      throw new Error("runtime communication ID collision");
    }
    const attachmentAuthority = this.options.attachmentAuthority;
    let reservationReceipt: RuntimeAttachmentReservationReceiptV3 | undefined;
    let result: RuntimeCommunicationV3Result;
    try {
      result = this.sqlite.transaction((): RuntimeCommunicationV3Result => {
        let insertedCommunication = false;
        try {
          // The scheduler write fence must precede the separately committed
          // asset reservation. Otherwise two attempts can share one
          // association, let the rejected attempt compensate it, and commit
          // the second attempt without durable attachment authority.
          reservationReceipt = preparedAttachments.bindings.length
            ? attachmentAuthority?.reserveCommunication(
              input.id,
              preparedAttachments.bindings,
            )
            : undefined;
          if (input.runAuthorization) {
            this.requireAuthorizedRun(input.runAuthorization, input.scopeKey);
          }
          this.requireProject(input.projectId);
          if (managedArtifactIds.length) {
            const authority = this.options.managedArtifactAttachmentAuthority;
            if (!authority) {
              throw new Error("managed artifact attachment authority is unavailable");
            }
            authority({
              projectId: input.projectId,
              artifactIds: managedArtifactIds,
              sender: input.sender,
              audience: input.audience,
            });
          }
          this.runtimeArtifactAuthority.requireRuntimeArtifacts(
            input.projectId,
            artifacts,
            "runtime communication",
          );
          if (!this.runtimeScopeAuthority.runtimeCommunicationAuthorityAgrees({
            projectId: input.projectId,
            sender: input.sender,
            intent: input.intent,
            audience: input.audience,
            payload,
            activations: activationInputs.map((activation, index) => ({
              agentId: activation.agentId,
              kind: activation.kind,
              scopeKey: activationScopeKeys[index]!,
            })),
          })) {
            throw new Error(
              "runtime communication authority does not agree on one Project",
            );
          }
          const existing = this.sqlite.prepare(`
            SELECT project_id, payload_hash FROM runtime_communications WHERE id = ?
          `).get(input.id) as {
            project_id: string;
            payload_hash: string;
          } | undefined;
          if (existing) {
            if (
              existing.project_id !== input.projectId ||
              existing.payload_hash !== hash
            ) {
              throw new Error("runtime communication ID collision");
            }
            const activations = this.sqlite.prepare(`
              SELECT a.id FROM agent_activations a
              JOIN activation_sources source ON source.activation_id = a.id
              WHERE source.source_kind = 'communication'
                AND source.source_id = ?
                AND a.project_id = ?
              ORDER BY a.created_at, a.id
            `).all(input.id, input.projectId) as Array<{ id: string }>;
            return {
              id: input.id,
              ...(activations[0]
                ? { activationId: activations[0].id }
                : {}),
              ...(activations.length
                ? {
                  activationIds: activations.map(
                    (activation) => activation.id,
                  ),
                }
                : {}),
              ...(artifacts.length
                ? {
                  artifactIds: artifacts.map((artifact) => artifact.id),
                }
                : {}),
              replayed: true,
            };
          }
          this.sqlite.prepare(`
            INSERT INTO runtime_communications (
              id, project_id, sender_json, intent, audience_json, payload_json,
              payload_hash, actionable, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.id,
            input.projectId,
            stableJson(input.sender),
            input.intent,
            stableJson(input.audience),
            stableJson(payload),
            hash,
            activationInputs.length ? 1 : 0,
            now,
          );
          insertedCommunication = true;
          const insertArtifact = this.sqlite.prepare(`
            INSERT INTO runtime_artifacts (
              id, owner_kind, owner_id, project_id, role, title, media_type,
              blob_path, blob_hash, byte_length, origin_agent_id, execution_id,
              created_at
            ) VALUES (?, 'communication', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const artifact of artifacts) {
            insertArtifact.run(
              artifact.id,
              input.id,
              input.projectId,
              artifact.role,
              artifact.title,
              artifact.mediaType,
              artifact.blobPath,
              artifact.blobHash.toLowerCase(),
              artifact.byteLength,
              artifact.originAgentId ?? null,
              artifact.executionId ?? null,
              now,
            );
          }
          const activationIds = activationInputs.map((activation, index) =>
            this.createActivation({
              projectId: input.projectId,
              agentId: activation.agentId,
              scopeKey: activationScopeKeys[index]!,
              kind: activation.kind,
              priority: activation.priority,
              dispatchPolicy: activation.dispatchPolicy,
              promptClass: activation.promptClass,
              dedupeKey:
                activation.dedupeKey ??
                `communication:${input.id}:${activation.agentId}:${index}`,
              payload,
              sourceKind: "communication",
              sourceId: input.id,
              externalIntake: true,
              now,
            }));
          return {
            id: input.id,
            ...(activationIds[0]
              ? { activationId: activationIds[0] }
              : {}),
            ...(activationIds.length ? { activationIds } : {}),
            ...(artifacts.length
              ? { artifactIds: artifacts.map((artifact) => artifact.id) }
              : {}),
            replayed: false,
          };
        } catch (schedulerError) {
          if (reservationReceipt && attachmentAuthority) {
            try {
              // Compensation remains inside the same scheduler fence as
              // reservation and publication, so another attempt cannot observe
              // or reuse an association that this attempt may release.
              const committed = this.sqlite.prepare(`
                SELECT project_id, payload_hash, payload_json
                FROM runtime_communications WHERE id = ?
              `).get(input.id) as {
                project_id: string;
                payload_hash: string;
                payload_json: string;
              } | undefined;
              // A row inserted by this callback is still visible here but will
              // roll back when the callback throws. Only a genuinely
              // pre-existing committed replay owns its association across this
              // failure.
              const compensationReceipt = insertedCommunication
                ? reservationReceipt
                : this.runtimeAttachmentAuthority
                  .compensationReceiptForCommittedRuntimeCommunication(
                    reservationReceipt,
                    committed,
                    input.projectId,
                    hash,
                  );
              if (compensationReceipt) {
                attachmentAuthority.compensateCommunication(
                  compensationReceipt,
                );
              }
            } catch (compensationError) {
              throw new AggregateError(
                [schedulerError, compensationError],
                "runtime Communication attachment compensation failed",
                { cause: schedulerError },
              );
            }
          }
          throw schedulerError;
        }
      }).immediate();
    } catch (transactionError) {
      if (reservationReceipt && attachmentAuthority) {
        try {
          // better-sqlite3 performs COMMIT after the callback returns. A COMMIT
          // failure therefore bypasses the callback catch above; reacquire the
          // scheduler fence and release only this attempt's exact reservation
          // when no concurrent attempt committed the Communication.
          this.sqlite.transaction(() => {
            const committed = this.sqlite.prepare(`
              SELECT project_id, payload_hash, payload_json
              FROM runtime_communications WHERE id = ?
            `).get(input.id) as {
              project_id: string;
              payload_hash: string;
              payload_json: string;
            } | undefined;
            const compensationReceipt = this.runtimeAttachmentAuthority
              .compensationReceiptForCommittedRuntimeCommunication(
                reservationReceipt!,
                committed,
                input.projectId,
                hash,
              );
            if (compensationReceipt) {
              attachmentAuthority.compensateCommunication(compensationReceipt);
            }
          }).immediate();
        } catch (compensationError) {
          throw new AggregateError(
            [transactionError, compensationError],
            "runtime Communication attachment compensation failed",
            { cause: transactionError },
          );
        }
      }
      throw transactionError;
    }
    // The filesystem-backed authority commits separately from scheduler SQLite.
    // Re-read every accepted attachment after the passive transaction commits;
    // callers must not project the canonical Communication when immutable bytes
    // disappeared or changed in that crash window. The scheduler row remains an
    // idempotent recovery boundary and an exact-byte restore can retry safely.
    this.runtimeAttachmentAuthority.revalidateRuntimeAttachments(
      input.projectId,
      preparedAttachments.bindings,
    );
    return result;
  }

  private managedArtifactIds(payloadValue: unknown): string[] {
    const payload = payloadValue && typeof payloadValue === "object" && !Array.isArray(payloadValue)
      ? payloadValue as Record<string, unknown>
      : undefined;
    const embedded = payload?.communication && typeof payload.communication === "object"
      && !Array.isArray(payload.communication)
      ? payload.communication as Record<string, unknown>
      : undefined;
    const communication = embedded
      ?? (payload && Object.prototype.hasOwnProperty.call(payload, "schemaVersion") ? payload : undefined);
    if (!communication || !Object.prototype.hasOwnProperty.call(communication, "artifactIds")) return [];
    const artifactIds = communication.artifactIds;
    if (!Array.isArray(artifactIds) || artifactIds.length === 0 || artifactIds.length > 20 ||
        new Set(artifactIds).size !== artifactIds.length ||
        artifactIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(id))) {
      throw new Error("managed artifact attachments are invalid");
    }
    return artifactIds;
  }
}
