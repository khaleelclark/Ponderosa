import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  TERMINAL_REQUEST_STATES,
  activationRetryDisposition,
  evaluateCoordinationJoin,
  joinTransitionNeedsActivation,
  reduceCoordinationRequest,
  type CoordinationJoinMode,
  type CoordinationJoinWakePolicy,
  type CoordinationReplyAuthority,
  type CoordinationJoinState,
  type CoordinationRequestState,
  type CoordinationRequestUpdateKind,
  type MessageDeliveryReceiptDto,
  type RetryMessageDeliveryResponse,
  type DerivedAgentAvailability,
  type TriggerDefinitionDto,
  type TriggerOccurrenceDto,
  type TriggerSourceConfig,
  type TriggerSourceKind,
} from "@ponderosa/core";
import { PendingActivationCapacityError, PRIORITY } from "./coordination-v3-activation.js";
import { TRIGGER_CANONICAL_JSON_LIMITS, payloadHash, stableJson } from "./coordination-v3-canonical-json.js";
import { CoordinationV3ReadModel } from "./coordination-v3-read-model.js";
import { CoordinationV3RequestReadModel } from "./coordination-v3-request-read-model.js";
import { CoordinationV3ActivationReadModel } from "./coordination-v3-activation-read-model.js";
import { CoordinationV3ActivationCommandAuthority } from "./coordination-v3-activation-command-authority.js";
import { CoordinationV3RuntimeAttachmentAuthority } from "./coordination-v3-runtime-attachment-authority.js";
import { CoordinationV3RuntimeArtifactAuthority } from "./coordination-v3-runtime-artifact-authority.js";
import { CoordinationV3RuntimeCommunicationReadModel } from "./coordination-v3-runtime-communication-read-model.js";
import { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import { CoordinationV3RunContextReadModel } from "./coordination-v3-run-context-read-model.js";
import { CoordinationV3SchedulerStatusReadModel } from "./coordination-v3-scheduler-status-read-model.js";
import { CoordinationV3OperationalOutboxAuthority } from "./coordination-v3-operational-outbox-authority.js";
import {
  CoordinationV3RuntimeCommunicationAuthority,
  type CreateActivationV3Input,
} from "./coordination-v3-runtime-communication-authority.js";
import { CoordinationV3ActivationFactory } from "./coordination-v3-activation-factory.js";
import { CoordinationV3ActivationLifecycleAuthority } from "./coordination-v3-activation-lifecycle-authority.js";
import {
  CoordinationV3StoreSupport,
  type RequestRow,
} from "./coordination-v3-store-support.js";
import { CoordinationV3DeletionAuthority } from "./coordination-v3-deletion-authority.js";
import { CoordinationV3CoordinateAuthority } from "./coordination-v3-coordinate-authority.js";
import { CoordinationV3QuestionAuthority } from "./coordination-v3-question-authority.js";
import { CoordinationV3TriggerOccurrenceAuthority } from "./coordination-v3-trigger-occurrence-authority.js";
import { CoordinationV3SteeringAuthority } from "./coordination-v3-steering-authority.js";
import { CoordinationV3SchedulerLeaseAuthority } from "./coordination-v3-scheduler-lease-authority.js";
import { CoordinationV3TriggerRegistry } from "./coordination-v3-trigger-registry.js";
import { terminalAt } from "./coordination-v3-request-state.js";
import {
  isIso,
} from "./coordination-v3-runtime-validation.js";
import type {
  Actor,
  CoordinateV3Input,
  CoordinateV3Result,
  UpdateRequestV3Input,
  RequestUpdateV3Result,
  CoordinationRequestV3View,
  CoordinationRequestDeliveryView,
  SchedulerLease,
  ActivationDispatchPolicy,
  ActivationPromptClass,
  ActivationTerminalOutcome,
  RuntimeCommunicationV3Input,
  RuntimeCommunicationV3Result,
  RuntimeCommunicationV3View,
  RuntimeArtifactInputV3,
  RuntimeArtifactV3,
  PendingActivationV3View,
  TerminalActivationV3View,
  SettleUnavailableActivationResult,
  CoordinationWaitCycleV3,
  SteeringLease,
  CancellationResult,
  SteeringRecoveryDecisionResult,
  ProviderOperation,
  OutboxItem,
  EnqueueMessageActivationInput,
  TriggerOccurrenceState,
  TriggerFilesystemBurst,
  CreateTriggerDefinitionInput,
  UpdateTriggerDefinitionInput,
  RecordTriggerOccurrenceInput,
  TriggerOccurrenceResult,
  CoordinationV3StoreOptions,
} from "./coordination-v3-types.js";
export type {
  RunAuthorizationV3,
  CoordinateV3Input,
  CoordinateV3Result,
  UpdateRequestV3Input,
  RequestUpdateV3Result,
  CoordinationRequestV3View,
  CoordinationRequestDeliveryView,
  SchedulerLease,
  ActivationDispatchPolicy,
  ActivationPromptClass,
  ActivationTerminalOutcome,
  RuntimeCommunicationV3Input,
  RuntimeCommunicationV3Result,
  RuntimeCommunicationV3View,
  RuntimeArtifactInputV3,
  RuntimeArtifactV3,
  RuntimeAttachmentAuthorityV3,
  RuntimeAttachmentReservationBindingV3,
  RuntimeAttachmentReservationReceiptV3,
  RuntimeAttachmentAuthorityProviderV3,
  RuntimeArtifactAuthorityV3,
  PendingActivationV3View,
  TerminalActivationV3View,
  SettleUnavailableActivationResult,
  CoordinationWaitCycleV3,
  SteeringLease,
  CancellationResult,
  SteeringRecoveryDecisionResult,
  ProviderOperation,
  OutboxItem,
  EnqueueMessageActivationInput,
  TriggerOccurrenceState,
  TriggerFilesystemBurst,
  CreateTriggerDefinitionInput,
  UpdateTriggerDefinitionInput,
  RecordTriggerOccurrenceInput,
  TriggerOccurrenceResult,
  CoordinationV3StoreOptions,
} from "./coordination-v3-types.js";

interface JoinRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  owner_agent_id: string;
  mode: CoordinationJoinMode;
  wake_policy: CoordinationJoinWakePolicy;
  quorum: number;
  satisfying_outcomes_json: string;
  state: CoordinationJoinState;
  deadline_at: string | null;
  continuation_request_ids_json: string;
}

interface ActivationRow {
  id: string;
  project_id: string;
  agent_id: string;
  scope_key: string;
  kind: string;
  priority: number;
  dispatch_policy: ActivationDispatchPolicy;
  prompt_class: ActivationPromptClass;
  state: string;
  dedupe_key: string;
  payload_json: string;
  available_at: string;
  delivery_failures: number;
  last_delivery_error: string | null;
  terminal_outcome: ActivationTerminalOutcome | null;
  terminal_at: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_MAX_PENDING_TRIGGER_OCCURRENCES_PER_AGENT = 1_000;
const DEFAULT_MAX_TRIGGER_ATTEMPTS = 8;

/** Transactional authority for Communication V3. Runtime telemetry may mirror
 * these transitions, but scheduler decisions must read this store. */
export class CoordinationV3Store {
  private readonly activationReadModel: CoordinationV3ActivationReadModel;
  private readonly activationCommandAuthority: CoordinationV3ActivationCommandAuthority;
  private readonly readModel: CoordinationV3ReadModel;
  private readonly requestReadModel: CoordinationV3RequestReadModel;
  private readonly runtimeAttachmentAuthority: CoordinationV3RuntimeAttachmentAuthority;
  private readonly runtimeArtifactAuthority: CoordinationV3RuntimeArtifactAuthority;
  private readonly runtimeCommunicationReadModel: CoordinationV3RuntimeCommunicationReadModel;
  private readonly runtimeCommunicationAuthority: CoordinationV3RuntimeCommunicationAuthority;
  private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority;
  private readonly runContextReadModel: CoordinationV3RunContextReadModel;
  private readonly schedulerStatusReadModel: CoordinationV3SchedulerStatusReadModel;
  private readonly operationalOutboxAuthority: CoordinationV3OperationalOutboxAuthority;
  private readonly triggerRegistry: CoordinationV3TriggerRegistry;
  private readonly activationFactory: CoordinationV3ActivationFactory;
  private readonly activationLifecycle: CoordinationV3ActivationLifecycleAuthority;
  private readonly support: CoordinationV3StoreSupport;
  private readonly deletionAuthority: CoordinationV3DeletionAuthority;
  private readonly coordinateAuthority: CoordinationV3CoordinateAuthority;
  private readonly questionAuthority: CoordinationV3QuestionAuthority;
  private readonly triggerOccurrenceAuthority!: CoordinationV3TriggerOccurrenceAuthority;
  private readonly steeringAuthority: CoordinationV3SteeringAuthority;
  private readonly schedulerLeaseAuthority: CoordinationV3SchedulerLeaseAuthority;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: CoordinationV3StoreOptions = {},
  ) {
    this.activationReadModel = new CoordinationV3ActivationReadModel(sqlite);
    this.activationFactory = new CoordinationV3ActivationFactory(sqlite, options);
    this.support = new CoordinationV3StoreSupport(sqlite);
    this.readModel = new CoordinationV3ReadModel(sqlite);
    this.requestReadModel = new CoordinationV3RequestReadModel(sqlite);
    this.runtimeAttachmentAuthority = new CoordinationV3RuntimeAttachmentAuthority(sqlite, options);
    this.runtimeArtifactAuthority = new CoordinationV3RuntimeArtifactAuthority(sqlite, options);
    this.runtimeScopeAuthority = new CoordinationV3RuntimeScopeAuthority(sqlite);
    this.activationLifecycle = new CoordinationV3ActivationLifecycleAuthority(
      sqlite,
      this.runtimeScopeAuthority,
      input => this.updateRequest(input),
      (activationIds, now) =>
        this.questionAuthority.settleQuestionsForFailedActivations(activationIds, now),
    );
    this.activationCommandAuthority = new CoordinationV3ActivationCommandAuthority(
      sqlite,
      this.runtimeScopeAuthority,
      this.runtimeArtifactAuthority,
      input => this.createActivation(input),
      (activationIds, now) =>
        this.activationLifecycle.settleRequestsForFailedActivations(
          activationIds,
          now,
        ),
    );
    this.runContextReadModel = new CoordinationV3RunContextReadModel(sqlite);
    this.schedulerStatusReadModel = new CoordinationV3SchedulerStatusReadModel(sqlite);
    this.operationalOutboxAuthority = new CoordinationV3OperationalOutboxAuthority(sqlite, options);
    this.runtimeCommunicationReadModel = new CoordinationV3RuntimeCommunicationReadModel(
      sqlite,
      this.runtimeScopeAuthority,
    );
    this.runtimeCommunicationAuthority = new CoordinationV3RuntimeCommunicationAuthority(
      sqlite,
      options,
      this.runtimeAttachmentAuthority,
      this.runtimeArtifactAuthority,
      this.runtimeScopeAuthority,
      (authorization, expectedScopeKey) =>
        this.support.requireAuthorizedRun(authorization, expectedScopeKey),
      projectId => this.support.requireProject(projectId),
      input => this.createActivation(input),
    );
    this.triggerRegistry = new CoordinationV3TriggerRegistry(
      sqlite,
      (triggerId, reason, now) =>
        this.triggerOccurrenceAuthority.cancelPendingTriggerWork(
          triggerId,
          reason,
          now,
        ),
      input => this.recordTriggerOccurrence(input),
    );
    this.triggerOccurrenceAuthority =
      new CoordinationV3TriggerOccurrenceAuthority(
        sqlite,
        options,
        this.support,
        this.triggerRegistry,
        input => this.createActivation(input),
      );
    this.questionAuthority = new CoordinationV3QuestionAuthority(
      sqlite,
      this.support,
      this.runtimeScopeAuthority,
      (runId, agentId) => this.requestIdsAttachedToRun(runId, agentId),
      (runId, agentId) =>
        this.outboundAwaitingQuestionRequestIdsAttachedToRun(
          runId,
          agentId,
        ),
      input => this.updateRequest(input),
      input => this.createActivation(input),
    );
    this.deletionAuthority = new CoordinationV3DeletionAuthority(
      sqlite,
      this.support,
      input => this.cancelAgentRun(input),
      (joinId, ownerAgentId, now) =>
        this.cancelJoin(joinId, ownerAgentId, now),
      input => this.updateRequest(input),
      (triggerId, now) => this.deleteTriggerDefinition(triggerId, now),
    );
    this.coordinateAuthority = new CoordinationV3CoordinateAuthority(
      sqlite,
      this.support,
      this.runtimeScopeAuthority,
      input => this.createActivation(input),
      (requestIds, ownerAgentId, dependencyKind, dependencyId, now) =>
        this.questionAuthority.insertQuestionSuspensions(
          requestIds,
          ownerAgentId,
          dependencyKind,
          dependencyId,
          now,
        ),
      input => this.updateRequest(input),
      (requestId, now) => this.reevaluateRequestJoins(requestId, now),
      (dependencyKind, dependencyId) =>
        this.questionAuthority.questionDependencyContinuations(
          dependencyKind,
          dependencyId,
        ),
      (activationId, dependencyKind, dependencyId, now, resolve) =>
        this.questionAuthority.attachQuestionDependencyToActivation(
          activationId,
          dependencyKind,
          dependencyId,
          now,
          resolve,
        ),
    );
    this.steeringAuthority = new CoordinationV3SteeringAuthority(
      sqlite,
      this.support,
      this.runtimeScopeAuthority,
      this.activationLifecycle,
      this.questionAuthority,
      input => this.createActivation(input),
      input => this.cancelAgentRun(input),
    );
    this.schedulerLeaseAuthority = new CoordinationV3SchedulerLeaseAuthority(
      sqlite,
      this.support,
      this.runtimeScopeAuthority,
      this.activationLifecycle,
      this.triggerRegistry,
      (runId, now, reason, eligibleStates) =>
        this.markRelatedRequestsOutcomeUnknown(
          runId,
          now,
          reason,
          eligibleStates,
        ),
    );
  }

  recordRuntimeCommunication(input: RuntimeCommunicationV3Input): RuntimeCommunicationV3Result {
    return this.runtimeCommunicationAuthority.recordRuntimeCommunication(input);
  }

  runtimeCommunications(projectId?: string): RuntimeCommunicationV3View[] {
    return this.runtimeCommunicationReadModel.runtimeCommunications(projectId);
  }

  runtimeCommunication(id: string): RuntimeCommunicationV3View | undefined {
    return this.runtimeCommunicationReadModel.runtimeCommunication(id);
  }

  runtimeArtifacts(ownerKind?: RuntimeArtifactV3["ownerKind"], ownerId?: string): RuntimeArtifactV3[] {
    return this.runtimeCommunicationReadModel.runtimeArtifacts(ownerKind, ownerId);
  }

  runtimeArtifact(id: string): RuntimeArtifactV3 | undefined {
    return this.runtimeCommunicationReadModel.runtimeArtifact(id);
  }

  requestForUpdate(updateId: string): CoordinationRequestV3View | undefined {
    return this.requestReadModel.requestForUpdate(updateId);
  }

  /** Project immutable authored messages onto mutable, per-recipient delivery
   * evidence without rewriting the Communication or its chat projection. */
  deliveryReceiptsForCommunication(projectId: string, communicationEventId: string): MessageDeliveryReceiptDto[] {
    return this.runtimeCommunicationReadModel.deliveryReceiptsForCommunication(
      projectId, communicationEventId,
    );
  }

  deliveryReceiptsForCommunications(
    projectId: string,
    communicationEventIds: readonly string[],
  ): Map<string, MessageDeliveryReceiptDto[]> {
    return this.runtimeCommunicationReadModel.deliveryReceiptsForCommunications(
      projectId, communicationEventIds,
    );
  }

  /** Create a new delivery attempt without duplicating the canonical user message. */
  retryMessageDelivery(input: {
    projectId: string;
    activationId: string;
    idempotencyKey: string;
    now?: string;
  }): RetryMessageDeliveryResponse {
    return this.activationCommandAuthority.retryMessageDelivery(input);
  }

  cancelTerminalMessageDelivery(input: {
    projectId: string;
    activationId: string;
    idempotencyKey: string;
    now?: string;
  }): { cancelled: boolean; replayed: boolean; state: "cancelled" | "not_cancellable"; targetAgentId?: string } {
    return this.activationCommandAuthority.cancelTerminalMessageDelivery(input);
  }

  pendingActivations(projectId?: string): PendingActivationV3View[] {
    return this.activationReadModel.pendingActivations(projectId);
  }

  terminalActivations(projectId?: string, limit = 100): TerminalActivationV3View[] {
    return this.activationReadModel.terminalActivations(projectId, limit);
  }

  settleUnavailableActivation(input: {
    activationId: string;
    projectId: string;
    idempotencyKey: string;
    reason?: string;
    now?: string;
  }): SettleUnavailableActivationResult {
    return this.activationCommandAuthority.settleUnavailableActivation(input);
  }

  reconcileUnavailableActivationRecipients(now = new Date().toISOString()): { settled: number } {
    return this.activationCommandAuthority.reconcileUnavailableActivationRecipients(now);
  }

  communicationRecipientAgentIds(projectId: string, communicationId: string): string[] {
    return this.runtimeCommunicationReadModel.communicationRecipientAgentIds(
      projectId, communicationId,
    );
  }

  cancelPendingActivation(input: {
    activationId: string;
    projectId: string;
    idempotencyKey: string;
    now?: string;
  }): { cancelled: boolean; replayed: boolean; status: "cancelled" | "delivery_started" } {
    return this.activationCommandAuthority.cancelPendingActivation(input);
  }

  editPendingActivationText(input: {
    activationId: string;
    projectId: string;
    requestText: string;
    text: string;
    document?: Record<string, unknown>;
    artifactId?: string;
    resultRef?: string;
    revisionOwnerId: string;
    artifact?: RuntimeArtifactInputV3;
    revisionOutboxPayload: unknown;
    idempotencyKey: string;
    now?: string;
  }): { edited: boolean; replayed: boolean; status: "edited" | "delivery_started" } {
    return this.activationCommandAuthority.editPendingActivationText(input);
  }

  steerPendingActivation(input: {
    activationId: string;
    projectId: string;
    idempotencyKey: string;
    now?: string;
  }): { steered: boolean; replayed: boolean; status: "steered" | "delivery_started" } {
    return this.activationCommandAuthority.steerPendingActivation(input);
  }

  activationPayloads(agentId: string, activationIds: string[], runId?: string): Array<{
    id: string; kind: string; promptClass: ActivationPromptClass; payload: unknown;
  }> {
    return this.activationReadModel.activationPayloads(agentId, activationIds, runId);
  }

  activationIdsAttachedToRun(runId: string, agentId: string): string[] {
    return this.activationReadModel.activationIdsAttachedToRun(runId, agentId);
  }

  requestIdsAttachedToRun(runId: string, agentId: string): string[] {
    return this.runContextReadModel.requestIdsAttachedToRun(runId, agentId);
  }

  outboundAwaitingQuestionRequestIdsAttachedToRun(runId: string, agentId: string): string[] {
    return this.runContextReadModel.outboundAwaitingQuestionRequestIdsAttachedToRun(
      runId, agentId,
    );
  }

  suspendQuestionsForDecision(input: {
    runId: string;
    agentId: string;
    decisionId: string;
    requestIds?: string[];
    strict?: boolean;
    now?: string;
  }): string[] {
    return this.questionAuthority.suspendQuestionsForDecision(input);
  }

  releaseDecisionQuestionSuspensions(decisionId: string, now = new Date().toISOString()): void {
    this.questionAuthority.releaseDecisionQuestionSuspensions(decisionId, now);
  }

  /** Ordinary recipient-to-requester messages during correlated work are
   * audit copies regardless of provider tool order. */
  requesterIdsForRun(runId: string, agentId: string): string[] {
    return this.runContextReadModel.requesterIdsForRun(runId, agentId);
  }

  runStartsNewRecipientRequest(runId: string, agentId: string): boolean {
    return this.runContextReadModel.runStartsNewRecipientRequest(runId, agentId);
  }

  runChangesScope(runId: string, agentId: string): boolean {
    return this.runContextReadModel.runChangesScope(runId, agentId);
  }

  coordinate(input: CoordinateV3Input, now = new Date().toISOString()): CoordinateV3Result {
    return this.coordinateAuthority.coordinate(input, now);
  }

  enqueueMessageActivation(input: EnqueueMessageActivationInput): string {
    return this.coordinateAuthority.enqueueMessageActivation(input);
  }

  createTriggerDefinition(input: CreateTriggerDefinitionInput): TriggerDefinitionDto {
    return this.triggerRegistry.create(input);
  }

  listTriggerDefinitions(agentId?: string): TriggerDefinitionDto[] {
    return this.triggerRegistry.list(agentId);
  }

  getTriggerDefinition(id: string): TriggerDefinitionDto | undefined {
    return this.triggerRegistry.get(id);
  }

  /** Server-internal encrypted webhook material. Never expose this object over HTTP. */
  getTriggerSecretCiphertext(id: string): string | undefined {
    return this.triggerRegistry.getSecretCiphertext(id);
  }

  allowTriggerRuns(id: string, additionalRuns: number, now = new Date().toISOString()): TriggerDefinitionDto | undefined {
    return this.triggerRegistry.allowRuns(id, additionalRuns, now);
  }

  updateTriggerDefinition(id: string, input: UpdateTriggerDefinitionInput): TriggerDefinitionDto | undefined {
    return this.triggerRegistry.update(id, input);
  }

  deleteTriggerDefinition(id: string, now = new Date().toISOString()): boolean {
    return this.triggerRegistry.delete(id, now);
  }

  listTriggerOccurrences(triggerId: string, limit = 100): TriggerOccurrenceDto[] {
    return this.triggerRegistry.listOccurrences(triggerId, limit);
  }

  listAgentTriggerOccurrences(agentId: string, limit = 100): TriggerOccurrenceDto[] {
    return this.triggerRegistry.listAgentOccurrences(agentId, limit);
  }

  listProjectTriggerOccurrences(projectId: string, limit = 100): TriggerOccurrenceDto[] {
    return this.triggerRegistry.listProjectOccurrences(projectId, limit);
  }

  getTriggerOccurrence(id: string): TriggerOccurrenceDto | undefined {
    return this.triggerRegistry.getOccurrence(id);
  }

  listPendingFilesystemTriggerBursts(): TriggerFilesystemBurst[] {
    return this.triggerRegistry.listPendingFilesystemBursts();
  }

  recordFilesystemTriggerEvent(input: {
    triggerId: string;
    path: string;
    eventType: string;
    maxCapturedPaths: number;
    now?: string;
  }): TriggerFilesystemBurst {
    return this.triggerRegistry.recordFilesystemEvent(input);
  }

  flushFilesystemTriggerBurst(triggerId: string): TriggerOccurrenceResult | undefined {
    return this.triggerRegistry.flushFilesystemBurst(triggerId);
  }

  isSchedulerRunCancelled(runId: string): boolean {
    return this.schedulerStatusReadModel.isSchedulerRunCancelled(runId);
  }

  listDueScheduleTriggers(now = new Date().toISOString(), limit = 100): TriggerDefinitionDto[] {
    return this.triggerRegistry.listDueSchedules(now, limit);
  }

  /** Persist external trigger intake before it can affect scheduling. The only
   * executable state this path may create is an Activation; Run ownership stays
   * exclusively in leaseNextRun(). */
  recordTriggerOccurrence(input: RecordTriggerOccurrenceInput): TriggerOccurrenceResult {
    return this.triggerOccurrenceAuthority.recordTriggerOccurrence(input);
  }

  /** Atomically persist one collapsed schedule recovery occurrence and advance
   * the schedule cursor. A stale source-service poll becomes a harmless replay. */
  recordScheduledTriggerOccurrence(input: RecordTriggerOccurrenceInput & {
    expectedNextFireAt: string;
    nextFireAt?: string;
    lastFiredAt: string;
  }): TriggerOccurrenceResult {
    return this.triggerOccurrenceAuthority.recordScheduledTriggerOccurrence(input);
  }

  processDueTriggerOccurrences(
    now = new Date().toISOString(),
    limit = 100,
  ): { activated: number; pending: number; deadLettered: number } {
    return this.triggerOccurrenceAuthority.processDueTriggerOccurrences(now, limit);
  }

  getAgentAvailability(agentId: string): DerivedAgentAvailability {
    return this.schedulerStatusReadModel.getAgentAvailability(agentId);
  }

  activeRunCount(): number {
    return this.schedulerStatusReadModel.activeRunCount();
  }

  ownsRun(runId: string, fencingToken: number, workerId?: string): boolean {
    return this.schedulerStatusReadModel.ownsRun(runId, fencingToken, workerId);
  }

  ownsRunForCleanup(runId: string, fencingToken: number, workerId?: string): boolean {
    return this.schedulerStatusReadModel.ownsRunForCleanup(runId, fencingToken, workerId);
  }

  ownsOutcomeUnknownRun(runId: string, fencingToken: number, workerId?: string): boolean {
    return this.schedulerStatusReadModel.ownsOutcomeUnknownRun(runId, fencingToken, workerId);
  }

  schedulerMetrics(): {
    pendingActivations: number;
    activeRuns: number;
    completedRuns: number;
    failedRuns: number;
    outcomeUnknownRuns: number;
    pendingActivationOutbox: number;
    deadLetteredActivationOutbox: number;
    pendingProviderOperations: number;
    deadLetteredProviderOperations: number;
    pendingTriggerOccurrences: number;
    deadLetteredTriggerOccurrences: number;
    recipientUnavailableActivations: number;
    permanentFailureActivations: number;
    retryExhaustedActivations: number;
  } {
    return this.readModel.schedulerMetrics();
  }

  /** Diagnose long-lived indefinite wait cycles without rejecting flexible
   * organization shapes. Consumers may surface these as operational warnings. */
  waitGraphCycles(
    now = new Date().toISOString(),
    minimumAgeMs = 5 * 60_000,
  ): CoordinationWaitCycleV3[] {
    return this.readModel.waitGraphCycles(now, minimumAgeMs);
  }

  /** Read-only projection of the authoritative coordination graph. Relationships
   * come from foreign-key/link tables, never from prompt or chat text. */
  teamOperationalRecords(input: {
    projectId: string;
    conversationId: string;
    limit: number;
    before?: { createdAt: string; id: string };
  }): Array<{
    id: string;
    kind: "run" | "activation" | "request" | "join" | "trigger";
    state: string;
    primaryAgentId: string;
    secondaryAgentId?: string;
    subtype?: string;
    completed?: number;
    total?: number;
    createdAt: string;
    updatedAt: string;
  }> {
    return this.readModel.teamOperationalRecords(input);
  }

  /** Read-only projection of the authoritative coordination graph. Relationships
   * come from foreign-key/link tables, never from prompt or chat text. */
  agentWorkItems(input: {
    projectId: string;
    conversationId?: string;
    agentId?: string;
    focusId?: string;
    limit?: number;
  }): { items: import("@ponderosa/core").AgentWorkItemDto[]; truncated: boolean } {
    return this.readModel.agentWorkItems(input);
  }

  /** Loads the technical fields for one canonical inspector record without
   * materializing payloads for the rest of the graph. */
  agentWorkItemDetails(input: {
    projectId: string;
    conversationId?: string;
    kind: "request" | "join" | "activation" | "run" | "trigger";
    recordId: string;
  }): Array<{ label: string; value: string }> | undefined {
    return this.readModel.agentWorkItemDetails(input);
  }

  agentSnapshot(agentId: string): import("@ponderosa/core").AgentCoordinationV3Dto {
    return this.schedulerStatusReadModel.agentSnapshot(agentId);
  }

  updateRequest(input: UpdateRequestV3Input): RequestUpdateV3Result {
    const now = input.now ?? new Date().toISOString();
    const initialRequest = this.support.getRequestRow(input.requestId);
    const artifacts = this.runtimeArtifactAuthority.resolveRuntimeArtifacts(
      initialRequest.project_id,
      input.artifacts,
      "request update",
    );
    const replayPayload = {
      requestId: input.requestId,
      kind: input.kind,
      actor: input.actor,
      inReplyToUpdateId: input.inReplyToUpdateId ?? null,
      payload: input.payload ?? null,
      artifacts,
    };
    const hash = payloadHash(replayPayload);
    return this.sqlite.transaction(() => {
      const request = this.support.getRequestRow(input.requestId);
      if (request.project_id !== initialRequest.project_id) throw new Error("request Project changed during artifact admission");
      const existing = this.sqlite.prepare(`
        SELECT request_id, actor_kind, actor_id, payload_hash, resulting_state, resulting_version
        FROM coordination_request_updates WHERE id = ?
      `).get(input.updateId) as {
        request_id: string; actor_kind: Actor["kind"]; actor_id: string | null;
        payload_hash: string; resulting_state: CoordinationRequestState; resulting_version: number;
      } | undefined;
      if (existing) {
        if (
          existing.request_id !== input.requestId || existing.actor_kind !== input.actor.kind ||
          existing.actor_id !== (input.actor.id ?? null) || existing.payload_hash !== hash
        ) throw new Error("request update idempotency collision");
        return {
          requestId: existing.request_id,
          state: existing.resulting_state,
          version: existing.resulting_version,
          replayed: true,
        };
      }

      const existingLate = this.sqlite.prepare(`
        SELECT request_id, actor_agent_id, payload_hash
        FROM coordination_request_late_results WHERE id = ?
      `).get(input.updateId) as { request_id: string; actor_agent_id: string; payload_hash: string } | undefined;
      if (existingLate) {
        if (existingLate.request_id !== input.requestId || input.actor.kind !== "agent" ||
            existingLate.actor_agent_id !== input.actor.id || existingLate.payload_hash !== hash) {
          throw new Error("request update idempotency collision");
        }
        return { requestId: request.id, state: request.state, version: request.version, replayed: true };
      }

      const lateTerminal = request.state === "outcome_unknown" &&
        (input.kind === "completed" || input.kind === "blocked" || input.kind === "failed") &&
        input.actor.kind === "agent" && input.actor.id === request.recipient_agent_id;
      if (lateTerminal) {
        if (!input.runAuthorization) throw new Error("late result requires authorization from the original outcome-unknown run");
        const authorized = this.sqlite.prepare(`
            SELECT 1 FROM scheduler_runs run
            WHERE run.id = ? AND run.agent_id = ? AND run.fencing_token = ?
              AND run.status = 'outcome_unknown'
              AND EXISTS (
                SELECT 1 FROM scheduler_run_activations attached
                JOIN activation_sources source ON source.activation_id = attached.activation_id
                LEFT JOIN coordination_request_updates request_update
                  ON source.source_kind = 'request_update' AND request_update.id = source.source_id
                WHERE attached.run_id = run.id AND (
                  (source.source_kind = 'request' AND source.source_id = ?)
                  OR (source.source_kind = 'request_update' AND request_update.request_id = ?)
                  OR (source.source_kind = 'join' AND EXISTS (
                    SELECT 1 FROM coordination_joins join_record,
                      json_each(join_record.continuation_request_ids_json) continuation
                    WHERE join_record.id = source.source_id AND continuation.value = ?
                  ))
                )
              )
        `).get(input.runAuthorization.runId, input.runAuthorization.agentId,
          input.runAuthorization.fencingToken, request.id, request.id, request.id);
        if (!authorized) throw new Error("late result is not authorized by the original outcome-unknown run");
        this.runtimeArtifactAuthority.requireRuntimeArtifacts(
          request.project_id,
          artifacts,
          "late request result",
        );
        this.sqlite.prepare(`
          INSERT INTO coordination_request_late_results (
            id, request_id, kind, actor_agent_id, payload_json, payload_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(input.updateId, request.id, input.kind, input.actor.id,
          stableJson(input.payload ?? null), hash, now);
        const insertArtifact = this.sqlite.prepare(`
          INSERT INTO runtime_artifacts (
            id, owner_kind, owner_id, project_id, role, title, media_type,
            blob_path, blob_hash, byte_length, origin_agent_id, execution_id, created_at
          ) VALUES (?, 'request_update', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const artifact of artifacts) insertArtifact.run(
          artifact.id, input.updateId, request.project_id, artifact.role, artifact.title, artifact.mediaType,
          artifact.blobPath, artifact.blobHash.toLowerCase(), artifact.byteLength,
          artifact.originAgentId ?? null, artifact.executionId ?? null, now,
        );
        if (request.requester_agent_id && this.support.agentSurvives(request.requester_agent_id)) this.createActivation({
          projectId: request.project_id, agentId: request.requester_agent_id,
          scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(request.conversation_id, request.requester_agent_id),
          kind: "coordination_late_result", priority: PRIORITY.actionable,
          dedupeKey: `request:${request.id}:late-result:${input.updateId}`,
          payload: {
            requestId: request.id, originalState: request.state,
            lateResult: { updateId: input.updateId, kind: input.kind, update: input.payload ?? null },
            recoveryInstruction: "Audit current state and incorporate this late handoff; do not redo the original work.",
          },
          sourceKind: "late_result", sourceId: input.updateId, now,
        });
        return { requestId: request.id, state: request.state, version: request.version, replayed: false };
      }

      if (input.runAuthorization) {
        this.support.requireAuthorizedRun(input.runAuthorization);
        const attached = this.requestIdsAttachedToRun(input.runAuthorization.runId, input.runAuthorization.agentId);
        const requesterOwnedTerminalControl =
          (input.kind === "cancelled" || input.kind === "superseded") &&
          input.actor.kind === "agent" &&
          input.actor.id === request.requester_agent_id &&
          input.runAuthorization.agentId === request.requester_agent_id;
        if (!attached.includes(input.requestId) && !requesterOwnedTerminalControl) {
          throw new Error("request is not attached to the authoritative run");
        }
      }
      this.runtimeArtifactAuthority.requireRuntimeArtifacts(
        request.project_id,
        artifacts,
        "request update",
      );

      this.support.authorizeUpdate(request, input.kind, input.actor);
      const ownsUnresolvedJoin = Boolean(this.sqlite.prepare(`
        SELECT 1 FROM coordination_joins
        WHERE state = 'open'
          AND EXISTS (
            SELECT 1 FROM json_each(continuation_request_ids_json)
            WHERE value = ?
          )
        LIMIT 1
      `).get(request.id));
      const next = reduceCoordinationRequest(
        {
          state: request.state,
          version: request.version,
          ...(request.open_question_update_id ? { openQuestionUpdateId: request.open_question_update_id } : {}),
          ownsUnresolvedJoin,
        },
        {
          kind: input.kind,
          updateId: input.updateId,
          ...(input.inReplyToUpdateId ? { inReplyToUpdateId: input.inReplyToUpdateId } : {}),
        },
      );
      this.sqlite.prepare(`
        INSERT INTO coordination_request_updates (
          id, request_id, kind, actor_kind, actor_id, in_reply_to_update_id,
          payload_json, payload_hash, resulting_state, resulting_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.updateId, request.id, input.kind, input.actor.kind, input.actor.id ?? null,
        input.inReplyToUpdateId ?? null, stableJson(input.payload ?? null), hash,
        next.state, next.version, now,
      );
      const insertArtifact = this.sqlite.prepare(`
        INSERT INTO runtime_artifacts (
          id, owner_kind, owner_id, project_id, role, title, media_type,
          blob_path, blob_hash, byte_length, origin_agent_id, execution_id, created_at
        ) VALUES (?, 'request_update', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of artifacts) {
        insertArtifact.run(
          artifact.id, input.updateId, request.project_id, artifact.role, artifact.title, artifact.mediaType,
          artifact.blobPath, artifact.blobHash.toLowerCase(), artifact.byteLength,
          artifact.originAgentId ?? null, artifact.executionId ?? null, now,
        );
      }
      this.sqlite.prepare(`
        UPDATE coordination_requests
        SET state = ?, version = ?, open_question_update_id = ?,
            updated_at = ?, terminal_at = ?
        WHERE id = ? AND version = ?
      `).run(
        next.state, next.version, next.openQuestionUpdateId ?? null, now,
        terminalAt(next.state, now), request.id, request.version,
      );
      if (
        request.open_question_update_id
        && request.open_question_update_id !== (next.openQuestionUpdateId ?? null)
      ) this.questionAuthority.settleClearedQuestion(request.open_question_update_id, now);

      const joined = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM coordination_join_members WHERE request_id = ?
      `).get(request.id) as { count: number }).count > 0;
      if (input.kind === "cancelled" || input.kind === "superseded" || input.kind === "expired") {
        this.cancelPendingRequestWork(request.id, input.kind, now);
      }
      this.reevaluateRequestJoins(request.id, now);
      this.activateForRequestTransition(request, input.kind, next.state, joined, input.updateId, input.payload, now);
      if (
        input.runAuthorization &&
        request.recipient_agent_id === input.runAuthorization.agentId &&
        !TERMINAL_REQUEST_STATES.has(request.state) &&
        TERMINAL_REQUEST_STATES.has(next.state) &&
        this.nonterminalInboundRequestIdsAttachedToRun(
          input.runAuthorization.runId,
          input.runAuthorization.agentId,
        ).length === 0
      ) {
        this.sqlite.prepare(`
          UPDATE scheduler_runs
          SET side_effects_fenced_at = COALESCE(side_effects_fenced_at, ?), updated_at = ?
          WHERE id = ? AND agent_id = ? AND fencing_token = ?
            AND status IN ('leased', 'running')
        `).run(
          now,
          now,
          input.runAuthorization.runId,
          input.runAuthorization.agentId,
          input.runAuthorization.fencingToken,
        );
      }
      return { requestId: request.id, state: next.state, version: next.version, replayed: false };
    })();
  }

  getRequest(requestId: string): CoordinationRequestV3View | undefined {
    return this.requestReadModel.getRequest(requestId);
  }

  requestDelivery(requestId: string): CoordinationRequestDeliveryView | undefined {
    return this.requestReadModel.requestDelivery(requestId);
  }

  requestRetryStatus(requestId: string): {
    activeRequestId?: string;
    completedRequestId?: string;
  } {
    return this.requestReadModel.requestRetryStatus(requestId);
  }

  attachRequestCommunication(requestId: string, communicationEventId: string, projectId: string): void {
    const changed = this.sqlite.prepare(`
      UPDATE coordination_requests SET communication_event_id = ?
      WHERE id = ? AND project_id = ?
        AND (communication_event_id IS NULL OR communication_event_id = ?)
    `).run(communicationEventId, requestId, projectId, communicationEventId).changes;
    if (changed !== 1) throw new Error("request communication identity conflict");
  }

  expireDue(now = new Date().toISOString()): { requests: number; joins: number } {
    return this.sqlite.transaction(() => {
      const requests = this.sqlite.prepare(`
        SELECT id FROM coordination_requests
        WHERE deadline_at IS NOT NULL AND deadline_at <= ?
          AND state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer')
        ORDER BY deadline_at, id
      `).all(now) as Array<{ id: string }>;
      for (const { id } of requests) {
        this.updateRequest({
          requestId: id,
          updateId: `system:expired:${id}:${now}`,
          kind: "expired",
          actor: { kind: "system", id: "deadline-sweeper" },
          payload: { deadlineObservedAt: now },
          now,
        });
      }
      const joins = this.sqlite.prepare(`
        SELECT * FROM coordination_joins
        WHERE deadline_at IS NOT NULL AND deadline_at <= ? AND state = 'open'
        ORDER BY deadline_at, id
      `).all(now) as JoinRow[];
      for (const join of joins) {
        this.sqlite.prepare(`
          UPDATE coordination_joins SET state = 'expired', updated_at = ?, terminal_at = ?
          WHERE id = ? AND state = 'open'
        `).run(now, now, join.id);
        if (this.support.agentSurvives(join.owner_agent_id)) this.createJoinActivation(join, "expired", now);
      }
      return { requests: requests.length, joins: joins.length };
    })();
  }

  /** On single-host startup every active lease owned by another server process
   * is orphaned. Pre-submission work is retryable; submitted or acknowledged
   * injections fail closed until an adapter can prove provider reconciliation. */
  recoverOrphanedRuns(workerId: string, now = new Date().toISOString()): { retried: number; outcomeUnknown: number } {
    return this.schedulerLeaseAuthority.recoverOrphanedRuns(workerId, now);
  }

  cancelJoin(joinId: string, ownerAgentId: string, now = new Date().toISOString()): boolean {
    return this.sqlite.transaction(() => {
      const join = this.sqlite.prepare(`SELECT * FROM coordination_joins WHERE id = ?`).get(joinId) as JoinRow | undefined;
      if (!join) throw new Error("join not found");
      if (join.owner_agent_id !== ownerAgentId) throw new Error("only the join owner may cancel it");
      if (join.state === "cancelled") return false;
      if (join.state !== "open") throw new Error(`join is terminal (${join.state})`);
      this.sqlite.prepare(`
        UPDATE coordination_joins SET state = 'cancelled', updated_at = ?, terminal_at = ? WHERE id = ?
      `).run(now, now, joinId);
      this.questionAuthority.releaseQuestionDependency("join", joinId, now);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE state IN ('pending', 'retry_pending') AND id IN (
          SELECT activation_id FROM activation_sources WHERE source_kind = 'join' AND source_id = ?
        )
      `).run(now, joinId);
      return true;
    })();
  }

  handleAgentDeletion(agentId: string, now = new Date().toISOString()): void {
    this.deletionAuthority.handleAgentDeletion(agentId, now);
  }

  /** Revoke one explicit Team Chat capability without affecting the Agent's
   * memberships or work in its other chats. */
  handleAgentConversationRemoval(
    agentId: string,
    conversationId: string,
    now = new Date().toISOString(),
  ): void {
    this.deletionAuthority.handleAgentConversationRemoval(
      agentId, conversationId, now,
    );
  }

  /** Fence and settle a whole project before any provider process is stopped.
   * The canonical project still exists during this phase, so a crash leaves a
   * retryable deletion with no live scheduler ownership. */
  prepareProjectDeletion(projectId: string, now = new Date().toISOString()): void {
    this.deletionAuthority.prepareProjectDeletion(projectId, now);
  }

  /** Remove every authoritative V3 row for a project. Call from the same
   * SQLite transaction that deletes the canonical project projections. */
  purgeProject(projectId: string): void {
    this.deletionAuthority.purgeProject(projectId);
  }

  leaseNextRun(input: {
    workerId: string;
    now?: string;
    leaseMs?: number;
    coalesceLimit?: number;
    excludedAgentIds?: readonly string[];
  }): SchedulerLease | undefined {
    return this.schedulerLeaseAuthority.leaseNextRun(input);
  }

  leaseNextSteering(input: { workerId: string; now?: string; coalesceLimit?: number }): SteeringLease | undefined {
    return this.steeringAuthority.leaseNextSteering(input);
  }

  deferSteering(input: {
    injectionId: string; runId: string; fencingToken: number; retryDelayMs?: number; now?: string;
  }): void {
    this.steeringAuthority.deferSteering(input);
  }

  markSteeringOutcomeUnknown(input: {
    injectionId: string; runId: string; fencingToken: number; now?: string;
    recoveryGraceMs?: number; error?: string;
  }): void {
    this.steeringAuthority.markSteeringOutcomeUnknown(input);
  }

  letCurrentRunFinish(input: {
    injectionId: string; idempotencyKey: string; now?: string;
  }): SteeringRecoveryDecisionResult {
    return this.steeringAuthority.letCurrentRunFinish(input);
  }

  latestAcknowledgedSteeringInjection(runId: string): string | undefined {
    return this.steeringAuthority.latestAcknowledgedSteeringInjection(runId);
  }

  steeringInjectionIds(runId: string): string[] {
    return this.steeringAuthority.steeringInjectionIds(runId);
  }

  processDueSteeringRecoveries(now = new Date().toISOString(), limit = 100): string[] {
    return this.steeringAuthority.processDueSteeringRecoveries(now, limit);
  }

  markRunStarted(runId: string, fence: number, now = new Date().toISOString()): void {
    this.support.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
    `, [now, now, runId, fence]);
  }

  setRunContextDisposition(
    runId: string,
    fence: number,
    disposition: "fresh_task" | "continued_session" | "reseeded",
    now = new Date().toISOString(),
  ): void {
    this.support.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs SET context_disposition = ?, updated_at = ?
      WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
    `, [disposition, now, runId, fence]);
  }

  /** Persist exactly what Ponderosa submitted, plus the reconstructible source recipe. */
  recordProviderInput(input: {
    executionId: string;
    schedulerRunId: string;
    fencingToken: number;
    agentId: string;
    projectId: string;
    prompt: string;
    sourceManifest: import("@ponderosa/core").ProviderInputSourceManifest;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const run = this.support.getFencedRun(input.schedulerRunId, input.fencingToken);
    if (run.agent_id !== input.agentId || run.project_id !== input.projectId) {
      throw new Error("provider input scope does not match its scheduler run");
    }
    const hash = createHash("sha256").update(input.prompt).digest("hex");
    this.sqlite.prepare(`
      INSERT INTO provider_inputs (
        execution_id, scheduler_run_id, agent_id, project_id, provider_prompt,
        prompt_hash, source_manifest_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        provider_prompt = excluded.provider_prompt,
        prompt_hash = excluded.prompt_hash,
        source_manifest_json = excluded.source_manifest_json,
        updated_at = excluded.updated_at
    `).run(
      input.executionId, input.schedulerRunId, input.agentId, input.projectId,
      input.prompt, hash, stableJson(input.sourceManifest), now, now,
    );
  }

  preparePromptInjection(input: {
    injectionId: string; runId: string; fencingToken: number; prompt: string; now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const hash = createHash("sha256").update(input.prompt).digest("hex");
    this.sqlite.transaction(() => {
      this.support.getFencedRun(input.runId, input.fencingToken);
      const row = this.sqlite.prepare(`
        SELECT prompt_hash, state FROM scheduler_prompt_injections WHERE id = ? AND run_id = ?
      `).get(input.injectionId, input.runId) as { prompt_hash: string; state: string } | undefined;
      if (!row) throw new Error("prompt injection not found");
      if (row.prompt_hash && row.prompt_hash !== hash) throw new Error("prompt injection payload changed");
      if (row.state !== "pending" && !row.prompt_hash) throw new Error("submitted injection has no durable prompt hash");
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections SET prompt_hash = ?, updated_at = ?
        WHERE id = ? AND run_id = ? AND state = 'pending'
      `).run(hash, now, input.injectionId, input.runId);
    })();
  }

  activationIdsForInjection(injectionId: string, runId: string): string[] {
    const row = this.sqlite.prepare(`
      SELECT activation_ids_json FROM scheduler_prompt_injections WHERE id = ? AND run_id = ?
    `).get(injectionId, runId) as { activation_ids_json: string } | undefined;
    return row ? JSON.parse(row.activation_ids_json) as string[] : [];
  }

  markPromptSubmitted(input: {
    injectionId: string; runId: string; fencingToken: number; providerSessionId?: string; now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      const run = this.support.getFencedRun(input.runId, input.fencingToken);
      const unavailableTrigger = this.sqlite.prepare(`
        SELECT occurrence.trigger_id AS trigger_id
        FROM scheduler_run_activations attached
        JOIN agent_activations activation ON activation.id = attached.activation_id
        JOIN trigger_occurrences occurrence ON occurrence.activation_id = activation.id
        LEFT JOIN trigger_definitions definition ON definition.id = occurrence.trigger_id
        WHERE attached.run_id = ? AND activation.kind = 'trigger_occurrence'
          AND definition.id IS NULL
        LIMIT 1
      `).get(input.runId) as { trigger_id: string } | undefined;
      if (unavailableTrigger) throw new Error(`Trigger ${unavailableTrigger.trigger_id} was deleted before prompt injection`);
      const changed = this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'submitted', submitted_at = COALESCE(submitted_at, ?), updated_at = ?
        WHERE id = ? AND run_id = ? AND state IN ('pending', 'submitted') AND prompt_hash <> ''
      `).run(now, now, input.injectionId, input.runId).changes;
      if (changed !== 1) throw new Error("prompt injection is not submit-ready");
      this.sqlite.prepare(`
        UPDATE scheduler_runs SET prompt_injection_state = 'injecting',
          provider_session_id = COALESCE(?, provider_session_id), heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
      `).run(input.providerSessionId ?? null, now, now, input.runId, input.fencingToken);
      if ((run.status as string) === "leased") this.sqlite.prepare(`
        UPDATE scheduler_runs SET status = 'running', started_at = COALESCE(started_at, ?)
        WHERE id = ? AND fencing_token = ?
      `).run(now, input.runId, input.fencingToken);
    })();
  }

  acknowledgePromptInjection(input: {
    injectionId: string; runId: string; fencingToken: number;
    providerTurnId?: string; providerSessionId?: string; now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      this.support.getFencedRun(input.runId, input.fencingToken);
      const changed = this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'acknowledged', provider_turn_id = COALESCE(?, provider_turn_id),
          acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?
        WHERE id = ? AND run_id = ? AND state IN ('submitted', 'acknowledged')
      `).run(input.providerTurnId ?? null, now, now, input.injectionId, input.runId).changes;
      if (changed !== 1) throw new Error("prompt injection was not submitted");
      this.sqlite.prepare(`
        UPDATE scheduler_runs SET prompt_injection_state = 'injected',
          provider_session_id = COALESCE(?, provider_session_id), heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND fencing_token = ? AND status = 'running'
      `).run(input.providerSessionId ?? null, now, now, input.runId, input.fencingToken);
    })();
  }

  renewLease(runId: string, fence: number, workerId: string, leaseMs = 30_000, now = new Date().toISOString()): string {
    const expires = new Date(Date.parse(now) + leaseMs).toISOString();
    this.support.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND fencing_token = ? AND lease_owner = ? AND status IN ('leased', 'running')
    `, [expires, now, now, runId, fence, workerId]);
    return expires;
  }

  completeRun(runId: string, fence: number, now = new Date().toISOString()): void {
    this.sqlite.transaction(() => {
      const unsettled = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM scheduler_prompt_injections
        WHERE run_id = ? AND state IN ('pending', 'submitted')
      `).get(runId) as { count: number }).count;
      if (unsettled > 0) throw new Error("run cannot complete with an unsettled prompt injection");
      this.support.mutateFencedRun(runId, fence, `
        UPDATE scheduler_runs SET status = 'completed', updated_at = ?, terminal_at = ?
        WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
      `, [now, now, runId, fence]);
      this.questionAuthority.settleUnansweredQuestionsForRun(runId, now, "completed");
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'consumed', updated_at = ?, consumed_at = ?
        WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
          AND state = 'attached'
      `).run(now, now, runId);
      this.sqlite.prepare(`
        UPDATE scheduler_run_activations SET consumed_at = ? WHERE run_id = ?
      `).run(now, runId);
      this.markRelatedRequestsOutcomeUnknown(
        runId,
        now,
        "run_completed_without_request_update",
        ["open", "in_progress"],
        ["open", "in_progress", "waiting_dependency"],
        false,
      );
    })();
  }

  failRun(input: {
    runId: string;
    fencingToken: number;
    workerId: string;
    sameRunResumable: boolean;
    now?: string;
    retryDelayMs?: number;
    leaseMs?: number;
    retryable?: boolean;
    terminalOutcome?: Exclude<ActivationTerminalOutcome, "retry_exhausted">;
    error?: string;
    maxDeliveryFailures?: number;
    /** Explicit provider rejection proves the prompt did not execute despite submission. */
    confirmedNotExecuted?: boolean;
    failureKind?: "capacity" | "rate_limit" | "authentication" | "context" | "unknown";
    failureDetail?: {
      phase: string;
      promptInjectionState: "not_injected" | "injecting" | "injected";
      exitCode?: number | null;
      signal?: string | null;
      stderr?: string;
      message?: string;
    };
  }): "retry" | "terminal" | "resume_same_run" | "outcome_unknown" {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const run = this.support.getFencedRun(input.runId, input.fencingToken);
      if (input.failureDetail) this.sqlite.prepare(`
        UPDATE scheduler_runs SET provider_failure_json = ?
        WHERE id = ? AND fencing_token = ?
      `).run(stableJson({
        ...input.failureDetail,
        ...(input.failureDetail.stderr ? { stderr: input.failureDetail.stderr.slice(-8_192) } : {}),
        ...(input.failureDetail.message ? { message: input.failureDetail.message.slice(0, 2_000) } : {}),
      }), input.runId, input.fencingToken);
      const disposition = input.confirmedNotExecuted ? "retry" : activationRetryDisposition({
        promptInjectionState: run.prompt_injection_state as "not_injected" | "injecting" | "injected",
        sameRunResumable: input.sameRunResumable,
      });
      if (disposition === "retry") {
        const error = (input.error ?? "scheduler dispatch rejected").slice(0, 2_000);
        const requestedMaximum = input.maxDeliveryFailures ?? 5;
        const maximum = Number.isFinite(requestedMaximum)
          ? Math.max(1, Math.floor(requestedMaximum)) : 5;
        const terminalOutcome = input.retryable === false
          ? input.terminalOutcome ?? "permanent_failure"
          : undefined;
        const currentFailures = (this.sqlite.prepare(`
          SELECT COALESCE(MAX(delivery_failures), 0) AS failures FROM agent_activations
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
        `).get(input.runId) as { failures: number }).failures;
        const capacityBackoff = input.failureKind === "capacity" || input.failureKind === "rate_limit"
          ? Math.min(120_000, 2_000 * (2 ** Math.min(currentFailures, 6)))
          : 1_000;
        const availableAt = new Date(Date.parse(now) + (input.retryDelayMs ?? capacityBackoff)).toISOString();
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET status = 'failed', updated_at = ?, terminal_at = ?
          WHERE id = ? AND fencing_token = ?
        `).run(now, now, input.runId, input.fencingToken);
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET delivery_failures = delivery_failures + 1,
            last_delivery_error = ?,
            state = CASE
              WHEN ? IS NOT NULL OR delivery_failures + 1 >= ? THEN 'failed'
              ELSE 'retry_pending'
            END,
            terminal_outcome = CASE
              WHEN ? IS NOT NULL THEN ?
              WHEN delivery_failures + 1 >= ? THEN 'retry_exhausted'
              ELSE NULL
            END,
            terminal_at = CASE
              WHEN ? IS NOT NULL OR delivery_failures + 1 >= ? THEN ?
              ELSE NULL
            END,
            available_at = ?, updated_at = ?
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
            AND state = 'attached'
        `).run(
          error,
          terminalOutcome ?? null, maximum,
          terminalOutcome ?? null, terminalOutcome ?? null, maximum,
          terminalOutcome ?? null, maximum, now,
          availableAt, now, input.runId,
        );
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state = 'pending'
        `).run(now, now, input.runId);
        if (input.confirmedNotExecuted) this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state IN ('submitted', 'injected')
        `).run(now, now, input.runId);
        const terminalActivations = (this.sqlite.prepare(`
          SELECT attached.activation_id AS id
          FROM scheduler_run_activations attached
          JOIN agent_activations activation ON activation.id = attached.activation_id
          WHERE attached.run_id = ? AND activation.state = 'failed'
            AND activation.terminal_outcome IS NOT NULL
        `).all(input.runId) as Array<{ id: string }>).map((row) => row.id);
        this.activationLifecycle.settleRequestsForFailedActivations(terminalActivations, now);
        const pending = (this.sqlite.prepare(`
          SELECT COUNT(*) AS count FROM agent_activations
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
            AND state = 'retry_pending'
        `).get(input.runId) as { count: number }).count;
        if (pending === 0) return "terminal";
      } else if (disposition === "resume_same_run") {
        const nextFence = this.support.nextFence(run.agent_id as string);
        const leaseExpiresAt = new Date(Date.parse(now) + (input.leaseMs ?? 30_000)).toISOString();
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
            fencing_token = ?, updated_at = ? WHERE id = ? AND fencing_token = ?
        `).run(input.workerId, leaseExpiresAt, nextFence, now, input.runId, input.fencingToken);
      } else {
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET status = 'outcome_unknown', updated_at = ?, terminal_at = ?
          WHERE id = ? AND fencing_token = ?
        `).run(now, now, input.runId, input.fencingToken);
        this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'outcome_unknown', updated_at = ?
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
            AND state = 'attached'
        `).run(now, input.runId);
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state IN ('pending', 'submitted')
        `).run(now, now, input.runId);
        this.markRelatedRequestsOutcomeUnknown(input.runId, now, "provider_outcome_unknown", [
          "open", "in_progress", "waiting_dependency", "awaiting_answer",
        ]);
      }
      return disposition;
    })();
  }

  cancelAgentRun(input: { agentId: string; idempotencyKey: string; expectedRunId?: string; now?: string }): CancellationResult {
    if (!input.idempotencyKey.trim()) throw new Error("cancellation idempotency key is required");
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const replay = this.sqlite.prepare(`
        SELECT run_id, accepted, fencing_token FROM scheduler_cancellation_receipts
        WHERE agent_id = ? AND idempotency_key = ?
      `).get(input.agentId, input.idempotencyKey) as {
        run_id: string | null; accepted: number; fencing_token: number | null;
      } | undefined;
      if (replay) return {
        cancelled: replay.accepted === 1,
        replayed: true,
        ...(replay.run_id ? { runId: replay.run_id } : {}),
        ...(replay.fencing_token !== null ? { fencingToken: replay.fencing_token } : {}),
      };
      const run = this.sqlite.prepare(`
        SELECT id, fencing_token FROM scheduler_runs
        WHERE agent_id = ? AND status IN ('leased', 'running') AND (? IS NULL OR id = ?)
      `).get(input.agentId, input.expectedRunId ?? null, input.expectedRunId ?? null) as { id: string; fencing_token: number } | undefined;
      if (!run) {
        this.sqlite.prepare(`
          INSERT INTO scheduler_cancellation_receipts (
            agent_id, idempotency_key, run_id, accepted, fencing_token, created_at
          ) VALUES (?, ?, NULL, 0, NULL, ?)
        `).run(input.agentId, input.idempotencyKey, now);
        return { cancelled: false, replayed: false };
      }
      const fence = this.support.nextFence(input.agentId);
      this.sqlite.prepare(`
        UPDATE scheduler_runs SET status = 'cancelled', fencing_token = ?, updated_at = ?, terminal_at = ?
        WHERE id = ?
      `).run(fence, now, now, run.id);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'outcome_unknown', updated_at = ?
        WHERE id IN (
          SELECT activation.value
          FROM scheduler_prompt_injections injection, json_each(injection.activation_ids_json) activation
          WHERE injection.run_id = ? AND injection.state = 'submitted'
        ) AND state = 'attached'
      `).run(now, run.id);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
          AND state = 'attached'
      `).run(now, run.id);
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND state = 'pending'
      `).run(now, now, run.id);
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND state = 'submitted'
      `).run(now, now, run.id);
      // Fencing stops future provider work but cannot prove which request-owned
      // effects already happened. Terminalize correlated work so its no-Join
      // requester or owning Join receives a deterministic recovery wake.
      this.markRelatedRequestsOutcomeUnknown(
        run.id,
        now,
        "run_cancelled_by_operator",
        ["open", "in_progress", "waiting_dependency", "awaiting_answer"],
      );
      this.sqlite.prepare(`
        INSERT INTO scheduler_cancellation_receipts (
          agent_id, idempotency_key, run_id, accepted, fencing_token, created_at
        ) VALUES (?, ?, ?, 1, ?, ?)
      `).run(input.agentId, input.idempotencyKey, run.id, fence, now);
      const operation = this.sqlite.prepare(`
        INSERT INTO provider_operation_outbox (
          run_id, operation, idempotency_key, payload_json, state,
          available_at, created_at, updated_at
        ) VALUES (?, 'interrupt', ?, ?, 'pending', ?, ?, ?)
      `).run(
        run.id, `cancel:${input.agentId}:${input.idempotencyKey}`,
        stableJson({ agentId: input.agentId, runId: run.id, fencingToken: fence }),
        now, now, now,
      );
      return {
        cancelled: true,
        replayed: false,
        runId: run.id,
        fencingToken: fence,
        operationId: Number(operation.lastInsertRowid),
      };
    })();
  }

  claimProviderOperations(workerId: string, limit = 20, now = new Date().toISOString(), staleMs = 30_000): ProviderOperation[] {
    return this.operationalOutboxAuthority.claimProviderOperations(workerId, limit, now, staleMs);
  }

  completeProviderOperation(id: number, workerId: string, now = new Date().toISOString()): void {
    this.operationalOutboxAuthority.completeProviderOperation(id, workerId, now);
  }

  failProviderOperation(id: number, workerId: string, error: string, retryDelayMs = 1_000, now = new Date().toISOString()): void {
    this.operationalOutboxAuthority.failProviderOperation(id, workerId, error, retryDelayMs, now);
  }

  deadLetterProviderOperation(id: number, workerId: string, error: string, now = new Date().toISOString()): void {
    this.operationalOutboxAuthority.deadLetterProviderOperation(id, workerId, error, now);
  }

  claimOutbox(workerId: string, limit = 50, now = new Date().toISOString(), staleMs = 30_000): OutboxItem[] {
    return this.operationalOutboxAuthority.claimOutbox(workerId, limit, now, staleMs);
  }

  completeOutbox(id: number, workerId: string, now = new Date().toISOString()): void {
    this.operationalOutboxAuthority.completeOutbox(id, workerId, now);
  }

  failOutbox(id: number, workerId: string, error: string): void {
    this.operationalOutboxAuthority.failOutbox(id, workerId, error);
  }

  pruneSettledOutboxes(retain = 10_000): { activationOutbox: number; providerOperations: number } {
    return this.operationalOutboxAuthority.pruneSettledOutboxes(retain);
  }

  private cancelPendingRequestWork(
    requestId: string,
    reason: "cancelled" | "superseded" | "expired",
    now: string,
  ): void {
    this.sqlite.prepare(`
      UPDATE agent_activations
      SET state = 'cancelled', terminal_outcome = NULL, terminal_at = ?,
        last_delivery_error = ?, updated_at = ?
      WHERE state IN ('pending', 'retry_pending')
        AND kind IN ('coordination_request', 'coordination_question')
        AND id IN (
          SELECT source.activation_id
          FROM activation_sources source
          LEFT JOIN coordination_request_updates request_update
            ON source.source_kind = 'request_update' AND request_update.id = source.source_id
          WHERE (source.source_kind = 'request' AND source.source_id = ?)
            OR (source.source_kind = 'request_update' AND request_update.request_id = ?)
        )
    `).run(now, `request ${reason} before delivery`, now, requestId, requestId);
  }

  private nonterminalInboundRequestIdsAttachedToRun(runId: string, agentId: string): string[] {
    return this.requestIdsAttachedToRun(runId, agentId).filter((requestId) => {
      const request = this.support.getRequestRow(requestId);
      return request.recipient_agent_id === agentId && !TERMINAL_REQUEST_STATES.has(request.state);
    });
  }

  private activateForRequestTransition(
    request: RequestRow,
    kind: CoordinationRequestUpdateKind,
    nextState: CoordinationRequestState,
    joined: boolean,
    updateId: string,
    updatePayload: unknown,
    now: string,
  ): void {
    if (kind === "question" && request.requester_agent_id && this.support.agentSurvives(request.requester_agent_id)) {
      this.createActivation({
        projectId: request.project_id, agentId: request.requester_agent_id,
        scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(request.conversation_id, request.requester_agent_id),
        kind: "coordination_question", priority: PRIORITY.urgent,
        dedupeKey: `request:${request.id}:question:${updateId}`,
        payload: { requestId: request.id, inReplyToUpdateId: updateId, update: updatePayload ?? null },
        sourceKind: "request_update", sourceId: updateId, now,
      });
      return;
    }
    if ((kind === "answer" || kind === "dependency_resolved") && this.support.agentSurvives(request.recipient_agent_id)) {
      this.createActivation({
        projectId: request.project_id, agentId: request.recipient_agent_id,
        scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(request.conversation_id, request.recipient_agent_id),
        kind: kind === "answer" ? "coordination_answer" : "coordination_dependency_resolved",
        priority: kind === "answer" ? PRIORITY.urgent : PRIORITY.actionable,
        dedupeKey: `request:${request.id}:${kind}:${updateId}`,
        payload: { requestId: request.id, updateId, update: updatePayload ?? null },
        sourceKind: "request_update", sourceId: updateId, now,
      });
      return;
    }
    if (kind === "cancelled" && this.support.isConsumedClarificationWait(request)) return;
    if ((kind === "cancelled" || kind === "superseded") && this.support.agentSurvives(request.recipient_agent_id)) {
      this.createActivation({
        projectId: request.project_id, agentId: request.recipient_agent_id,
        scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(request.conversation_id, request.recipient_agent_id),
        kind: `coordination_${kind}`, priority: PRIORITY.urgent,
        ...(kind === "cancelled" ? { dispatchPolicy: "steer_or_run" as const } : {}),
        dedupeKey: `request:${request.id}:${kind}`,
        payload: { requestId: request.id, state: nextState, update: updatePayload ?? null },
        sourceKind: "request", sourceId: request.id, now,
      });
      return;
    }
    const requestPayload = JSON.parse(request.payload_json) as { completionMode?: unknown } | null;
    const recordOnly = requestPayload?.completionMode === "record";
    const replyAuthority = request.reply_authority_json
      ? JSON.parse(request.reply_authority_json) as CoordinationReplyAuthority
      : undefined;
    if (TERMINAL_REQUEST_STATES.has(nextState) && !joined && !recordOnly && request.requester_agent_id && this.support.agentSurvives(request.requester_agent_id)) {
      this.createActivation({
        projectId: request.project_id, agentId: request.requester_agent_id,
        scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(request.conversation_id, request.requester_agent_id),
        kind: "coordination_outcome",
        priority: nextState === "completed" ? PRIORITY.satisfied : PRIORITY.actionable,
        dedupeKey: `request:${request.id}:terminal`,
        payload: {
          requestId: request.id, state: nextState, update: updatePayload ?? null,
          ...(replyAuthority ? { replyAuthority } : {}),
        },
        sourceKind: "request", sourceId: request.id, now,
      });
    }
  }

  private reevaluateRequestJoins(requestId: string, now: string): void {
    const joins = this.sqlite.prepare(`
      SELECT j.* FROM coordination_joins j
      JOIN coordination_join_members m ON m.join_id = j.id
      WHERE m.request_id = ? AND j.state = 'open'
    `).all(requestId) as JoinRow[];
    for (const join of joins) {
      const requestRows = this.sqlite.prepare(`
        SELECT r.id, r.state FROM coordination_join_members m
        JOIN coordination_requests r ON r.id = m.request_id
        WHERE m.join_id = ? ORDER BY m.position
      `).all(join.id) as Array<{ id: string; state: CoordinationRequestState }>;
      const requestIds = requestRows.map((row) => row.id);
      const states = new Map(requestRows.map((row) => [row.id, row.state]));
      const next = evaluateCoordinationJoin({
        state: join.state,
        mode: join.mode,
        quorum: join.quorum,
        requestIds,
        satisfyingOutcomes: JSON.parse(join.satisfying_outcomes_json) as CoordinationRequestState[],
      }, states);
      if (next === join.state) {
        const changedRequest = requestRows.find((row) => row.id === requestId);
        if (
          join.wake_policy === "each_result"
          && changedRequest
          && TERMINAL_REQUEST_STATES.has(changedRequest.state)
          && this.support.agentSurvives(join.owner_agent_id)
        ) {
          this.createJoinActivation(join, "open", now, requestId);
        }
        continue;
      }
      this.sqlite.prepare(`
        UPDATE coordination_joins SET state = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND state = 'open'
      `).run(next, now, now, join.id);
      if (joinTransitionNeedsActivation(join.state, next) && this.support.agentSurvives(join.owner_agent_id)) {
        this.createJoinActivation(join, next, now);
      }
    }
  }

  private createJoinActivation(
    join: JoinRow,
    state: CoordinationJoinState,
    now: string,
    progressRequestId?: string,
  ): void {
    const outcomes = this.sqlite.prepare(`
      SELECT r.id AS request_id, r.state, r.payload_json AS request_payload_json,
        r.reply_authority_json,
        u.id AS update_id, u.kind AS update_kind,
        u.payload_json AS update_payload_json, u.created_at AS update_created_at
      FROM coordination_join_members m
      JOIN coordination_requests r ON r.id = m.request_id
      LEFT JOIN coordination_request_updates u
        ON u.request_id = r.id AND u.resulting_version = r.version
      WHERE m.join_id = ?
      ORDER BY m.position
    `).all(join.id) as Array<{
      request_id: string;
      state: CoordinationRequestState;
      request_payload_json: string;
      reply_authority_json: string | null;
      update_id: string | null;
      update_kind: CoordinationRequestUpdateKind | null;
      update_payload_json: string | null;
      update_created_at: string | null;
    }>;
    const continuations = (JSON.parse(join.continuation_request_ids_json) as string[]).map((requestId) => {
      const request = this.support.getRequestRow(requestId) as RequestRow & { payload_json: string };
      return {
        requestId: request.id,
        state: request.state,
        direction: request.recipient_agent_id === join.owner_agent_id ? "inbound" : "outbound_question",
        ...(request.recipient_agent_id === join.owner_agent_id || !request.open_question_update_id
          ? {}
          : { inReplyToUpdateId: request.open_question_update_id }),
        request: JSON.parse(request.payload_json) as unknown,
      };
    });
    const terminalCount = outcomes.filter((outcome) => TERMINAL_REQUEST_STATES.has(outcome.state)).length;
    const replyAuthorityJson = outcomes.map((outcome) => outcome.reply_authority_json);
    const inheritedReplyAuthority = replyAuthorityJson.length > 0 && replyAuthorityJson.every((value) => value !== null) &&
      new Set(replyAuthorityJson).size === 1
      ? JSON.parse(replyAuthorityJson[0]!) as CoordinationReplyAuthority
      : undefined;
    const visibleOutcomes = progressRequestId
      ? outcomes.filter((outcome) => outcome.request_id === progressRequestId)
      : outcomes;
    const progress = {
      terminal: terminalCount,
      total: outcomes.length,
      remaining: outcomes.length - terminalCount,
      ...(progressRequestId ? { newlyTerminalRequestIds: [progressRequestId] } : {}),
    };
    const isProgress = state === "open" && Boolean(progressRequestId);
    const activationId = this.createActivation({
      projectId: join.project_id,
      agentId: join.owner_agent_id,
      scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(join.conversation_id, join.owner_agent_id),
      kind: isProgress ? "coordination_join_progress" : `coordination_join_${state}`,
      priority: state === "satisfied" ? PRIORITY.satisfied : PRIORITY.actionable,
      dedupeKey: isProgress ? `join:${join.id}:progress:${progressRequestId}` : `join:${join.id}:terminal`,
      payload: {
        joinId: join.id,
        state,
        wakePolicy: join.wake_policy,
        progress,
        ...(inheritedReplyAuthority ? { replyAuthority: inheritedReplyAuthority } : {}),
        outcomes: visibleOutcomes.map((outcome) => ({
          requestId: outcome.request_id,
          state: outcome.state,
          request: JSON.parse(outcome.request_payload_json) as unknown,
          ...(outcome.update_id ? {
            update: {
              id: outcome.update_id,
              kind: outcome.update_kind,
              payload: JSON.parse(outcome.update_payload_json ?? "null") as unknown,
              createdAt: outcome.update_created_at,
            },
          } : {}),
        })),
        ...(continuations.length ? {
          continuations,
          continuationInstruction: [
            isProgress
              ? "Act on the newly returned outcome while other aggregate work continues. Do not terminally update an inbound continuation while this Join remains open."
              : "Integrate the joined outcomes, then terminally update every nonterminal inbound continuation before ending this Run.",
            continuations.some((continuation) => continuation.direction === "outbound_question")
              ? "For every outbound_question still awaiting an answer, reply using its exact inReplyToUpdateId. Never terminally update work assigned to another Agent."
              : "",
            isProgress
              ? "When no independent work remains, end this Run to return to durable waiting."
              : "Sending a message does not fulfill a correlated request.",
          ].filter(Boolean).join(" "),
        } : {}),
      },
      sourceKind: "join",
      sourceId: join.id,
      now,
    });
    this.questionAuthority.attachQuestionDependencyToActivation(
      activationId, "join", join.id, now, state !== "open",
    );
  }

  resetExpiredTriggerBudgets(now = new Date().toISOString()): number {
    return this.triggerOccurrenceAuthority.resetExpiredTriggerBudgets(now);
  }

  private createActivation(input: CreateActivationV3Input): string {
    return this.activationFactory.create(input);
  }

  private markRelatedRequestsOutcomeUnknown(
    runId: string,
    now: string,
    reason: string,
    eligibleStates: CoordinationRequestState[],
    continuationEligibleStates: CoordinationRequestState[] = eligibleStates,
    settleOutboundQuestions = true,
  ): void {
    const placeholders = eligibleStates.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT r.id
      FROM scheduler_run_activations ra
      JOIN scheduler_runs run ON run.id = ra.run_id
      JOIN activation_sources source ON source.activation_id = ra.activation_id
      LEFT JOIN coordination_request_updates update_record
        ON source.source_kind = 'request_update' AND update_record.id = source.source_id
      JOIN coordination_requests r ON r.id = CASE
        WHEN source.source_kind = 'request' THEN source.source_id
        WHEN source.source_kind = 'request_update' THEN update_record.request_id
      END
      WHERE ra.run_id = ?
        AND r.recipient_agent_id = run.agent_id
        AND r.state IN (${placeholders})
    `).all(runId, ...eligibleStates) as Array<{ id: string }>;
    const continuationPlaceholders = continuationEligibleStates.map(() => "?").join(", ");
    const continuationRows = this.sqlite.prepare(`
      SELECT DISTINCT request.id
      FROM scheduler_run_activations attached
      JOIN scheduler_runs run ON run.id = attached.run_id
      JOIN activation_sources source
        ON source.activation_id = attached.activation_id AND source.source_kind = 'join'
      JOIN coordination_joins join_record ON join_record.id = source.source_id
      JOIN json_each(join_record.continuation_request_ids_json) continuation
      JOIN coordination_requests request ON request.id = continuation.value
      WHERE attached.run_id = ?
        AND request.recipient_agent_id = run.agent_id
        AND request.state IN (${continuationPlaceholders})
        AND NOT EXISTS (
          SELECT 1
          FROM coordination_joins open_join
          JOIN json_each(open_join.continuation_request_ids_json) open_continuation
          WHERE open_join.owner_agent_id = run.agent_id
            AND open_join.state = 'open'
            AND open_continuation.value = request.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM activation_sources terminal_source
          JOIN agent_activations terminal_activation
            ON terminal_activation.id = terminal_source.activation_id
          WHERE terminal_source.source_kind = 'join'
            AND terminal_source.source_id = join_record.id
            AND terminal_activation.kind IN ('coordination_join_satisfied', 'coordination_join_impossible')
            AND terminal_activation.state IN ('pending', 'retry_pending', 'leased')
        )
    `).all(runId, ...continuationEligibleStates) as Array<{ id: string }>;
    const related = [...new Map([...rows, ...continuationRows].map((row) => [row.id, row])).values()];
    for (const row of related) this.updateRequest({
      requestId: row.id,
      updateId: `system:outcome-unknown:${runId}:${row.id}`,
      kind: "outcome_unknown",
      actor: { kind: "supervisor", id: "v3-runtime-supervisor" },
      payload: { reason, runId },
      now,
    });
    if (settleOutboundQuestions) {
      this.questionAuthority.settleUnansweredQuestionsForRun(runId, now, "outcome_unknown", reason);
    }
  }

}
