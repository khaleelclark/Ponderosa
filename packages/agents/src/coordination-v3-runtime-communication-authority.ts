import type Database from "better-sqlite3";
import type { CommunicationAudience } from "@ponderosa/core";
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
    private readonly markRequiredReplySatisfied: (input: {
      runId: string;
      communicationId: string;
      intent: string;
      audience: CommunicationAudience;
      taskDelivery?: "final" | "blocked";
      now: string;
    }) => void,
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
    if (input.taskDelivery !== undefined &&
        ((input.taskDelivery !== 'final' && input.taskDelivery !== 'blocked') || !input.runAuthorization ||
         !input.satisfiesRequiredReply || (input.intent !== 'broadcast' && input.intent !== 'user_dm'))) {
      throw new Error('task delivery requires an exact authorized operator-facing outcome');
    }
    if (input.taskDelivery !== undefined && (!payload || typeof payload !== 'object' ||
        (payload as { taskDelivery?: unknown }).taskDelivery !== input.taskDelivery)) {
      throw new Error('task delivery outcome must match its exact durable receipt');
    }
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
            let activations = this.sqlite.prepare(`
              SELECT activation_id, agent_id
              FROM runtime_communication_activation_intake
              WHERE communication_id = ?
              ORDER BY recipient_index
            `).all(input.id) as Array<{ activation_id: string; agent_id: string }>;
            if (activations.length === 0 && activationInputs.length > 0) {
              activations = this.restorePreIntakeMapping(
                input.id,
                input.projectId,
                activationInputs,
              );
            }
            if (activations.length !== activationInputs.length) {
              throw new Error("runtime communication intake mapping is unavailable");
            }
            if (input.runAuthorization && input.satisfiesRequiredReply) this.markRequiredReplySatisfied({
              runId: input.runAuthorization.runId,
              communicationId: input.id,
              intent: input.intent,
              audience: input.audience,
              ...(input.taskDelivery ? { taskDelivery: input.taskDelivery } : {}),
              now,
            });
            return {
              id: input.id,
              ...(activations[0]
                ? { activationId: activations[0].activation_id }
                : {}),
              ...(activations.length
                ? {
                  activationIds: activations.map(
                    (activation) => activation.activation_id,
                  ),
                  activations: activations.map((activation) => ({
                    id: activation.activation_id,
                    agentId: activation.agent_id,
                  })),
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
          if (input.runAuthorization && input.satisfiesRequiredReply) this.markRequiredReplySatisfied({
            runId: input.runAuthorization.runId,
            communicationId: input.id,
            intent: input.intent,
            audience: input.audience,
            ...(input.taskDelivery ? { taskDelivery: input.taskDelivery } : {}),
            now,
          });
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
          const readActivation = this.sqlite.prepare(`
            SELECT id, agent_id FROM agent_activations
            WHERE id = ? AND project_id = ?
          `);
          const activations = activationIds.map((id) => {
            const activation = readActivation.get(id, input.projectId) as {
              id: string;
              agent_id: string;
            } | undefined;
            if (!activation) throw new Error("runtime communication activation is unavailable");
            return { id: activation.id, agentId: activation.agent_id };
          });
          const insertActivationIntake = this.sqlite.prepare(`
            INSERT INTO runtime_communication_activation_intake (
              communication_id, recipient_index, agent_id, activation_id
            ) VALUES (?, ?, ?, ?)
          `);
          for (const [index, activation] of activations.entries()) {
            insertActivationIntake.run(
              input.id,
              index,
              activation.agentId,
              activation.id,
            );
          }
          return {
            id: input.id,
            ...(activationIds[0]
              ? { activationId: activationIds[0] }
              : {}),
            ...(activationIds.length ? { activationIds, activations } : {}),
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
    // Managed blobs and runtime-upload associations commit separately from
    // scheduler SQLite. Re-read accepted bytes only after the write fence is
    // released. Exact committed replays bypass mutable artifact admission and
    // report their durable result even if an operator later deletes the file.
    if (!result.replayed && managedArtifactIds.length) {
      const revalidator = this.options.managedArtifactAttachmentRevalidator;
      if (!revalidator) {
        throw new Error("managed artifact attachment revalidator is unavailable");
      }
      revalidator({
        projectId: input.projectId,
        artifactIds: managedArtifactIds,
        sender: input.sender,
        audience: input.audience,
      });
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

  /** Databases created before the intake-mapping extension already have the
   * immutable Communication hash and the exact original Activation dedupe
   * keys. Recover only from those keys during an exact replay. Descendant
   * lineage is deliberately irrelevant: retry and rollover Activations cannot
   * own the original `(project, agent, dedupe_key)` tuple. */
  private restorePreIntakeMapping(
    communicationId: string,
    projectId: string,
    activationInputs: NonNullable<RuntimeCommunicationV3Input["activations"]>,
  ): Array<{ activation_id: string; agent_id: string }> {
    const findOriginal = this.sqlite.prepare(`
      SELECT activation.id, activation.agent_id
      FROM agent_activations activation
      JOIN activation_sources source
        ON source.activation_id = activation.id
       AND source.source_kind = 'communication'
       AND source.source_id = ?
      WHERE activation.project_id = ?
        AND activation.agent_id = ?
        AND activation.dedupe_key = ?
    `);
    const recovered = activationInputs.map((activation, index) => {
      const dedupeKey = activation.dedupeKey ??
        `communication:${communicationId}:${activation.agentId}:${index}`;
      const row = findOriginal.get(
        communicationId,
        projectId,
        activation.agentId,
        dedupeKey,
      ) as { id: string; agent_id: string } | undefined;
      if (!row) {
        throw new Error("runtime communication intake mapping is unavailable");
      }
      return { activation_id: row.id, agent_id: row.agent_id };
    });
    const insert = this.sqlite.prepare(`
      INSERT INTO runtime_communication_activation_intake (
        communication_id, recipient_index, agent_id, activation_id
      ) VALUES (?, ?, ?, ?)
    `);
    for (const [index, activation] of recovered.entries()) {
      insert.run(
        communicationId,
        index,
        activation.agent_id,
        activation.activation_id,
      );
    }
    return recovered;
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
