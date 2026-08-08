import type Database from "better-sqlite3";
import {
  type MessageDeliveryReceiptDto,
  type RetryMessageDeliveryResponse,
  type DerivedAgentAvailability,
  type TriggerDefinitionDto,
  type TriggerOccurrenceDto,
} from "@ponderosa/core";
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
import { CoordinationV3ContextRolloverAuthority } from "./coordination-v3-context-rollover-authority.js";
import { CoordinationV3ActivationLifecycleAuthority } from "./coordination-v3-activation-lifecycle-authority.js";
import { CoordinationV3StoreSupport } from "./coordination-v3-store-support.js";
import { CoordinationV3DeletionAuthority } from "./coordination-v3-deletion-authority.js";
import { CoordinationV3CoordinateAuthority } from "./coordination-v3-coordinate-authority.js";
import { CoordinationV3QuestionAuthority } from "./coordination-v3-question-authority.js";
import { CoordinationV3TriggerOccurrenceAuthority } from "./coordination-v3-trigger-occurrence-authority.js";
import { CoordinationV3SteeringAuthority } from "./coordination-v3-steering-authority.js";
import { CoordinationV3SchedulerLeaseAuthority } from "./coordination-v3-scheduler-lease-authority.js";
import { CoordinationV3RequestAuthority } from "./coordination-v3-request-authority.js";
import { CoordinationV3RunLifecycleAuthority } from "./coordination-v3-run-lifecycle-authority.js";
import { CoordinationV3TriggerRegistry } from "./coordination-v3-trigger-registry.js";
import {
  CommunicationV4NextRunDeliveryAuthority,
  type CommunicationV4NextRunDelivery,
  type NextRunDeliveryMaintenanceResult,
  type OperatorNextRunDeliveryReceipt,
  type PublishAgentNextRunDeliveryInput,
  type PublishNextRunDeliveryResult,
  type PublishOperatorNextRunDeliveryInput,
} from "./communication-v4-next-run-delivery-authority.js";
import type {
  CoordinateV3Input,
  CoordinateV3Result,
  UpdateRequestV3Input,
  RequestUpdateV3Result,
  CoordinationRequestV3View,
  CoordinationRequestDeliveryView,
  SchedulerLease,
  ActivationPromptClass,
  ActivationTerminalOutcome,
  RuntimeCommunicationV3Input,
  RuntimeCommunicationV3Result,
  RuntimeCommunicationV3View,
  RuntimeArtifactInputV3,
  RuntimeArtifactV3,
  RuntimeManagedArtifactAttachmentAuthorizationV3,
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
  TriggerFilesystemBurst,
  CreateTriggerDefinitionInput,
  UpdateTriggerDefinitionInput,
  RecordTriggerOccurrenceInput,
  TriggerOccurrenceResult,
  CoordinationV3StoreOptions,
  ContextRolloverV3,
} from "./coordination-v3-types.js";
export type {
  CommunicationV4NextRunDelivery,
  NextRunDeliveryMaintenanceResult,
  OperatorNextRunDeliveryReceipt,
  PublishAgentNextRunDeliveryInput,
  PublishNextRunDeliveryResult,
  PublishOperatorNextRunDeliveryInput,
} from "./communication-v4-next-run-delivery-authority.js";
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
  RuntimeManagedArtifactAttachmentAuthorizationV3,
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
  ContextRolloverState,
  ContextRolloverV3,
} from "./coordination-v3-types.js";

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
  private readonly requestAuthority: CoordinationV3RequestAuthority;
  private readonly runLifecycleAuthority: CoordinationV3RunLifecycleAuthority;
  private readonly contextRolloverAuthority: CoordinationV3ContextRolloverAuthority;
  private readonly communicationV4NextRunDeliveries: CommunicationV4NextRunDeliveryAuthority;

  constructor(
    sqlite: Database.Database,
    options: CoordinationV3StoreOptions = {},
  ) {
    this.activationReadModel = new CoordinationV3ActivationReadModel(sqlite);
    this.activationFactory = new CoordinationV3ActivationFactory(sqlite, options);
    this.contextRolloverAuthority = new CoordinationV3ContextRolloverAuthority(
      sqlite,
      input => this.createActivation(input),
    );
    this.support = new CoordinationV3StoreSupport(sqlite);
    this.communicationV4NextRunDeliveries = new CommunicationV4NextRunDeliveryAuthority(
      sqlite,
      (authorization, expectedScopeKey) =>
        this.support.requireAuthorizedRun(authorization, expectedScopeKey),
    );
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
    this.requestAuthority = new CoordinationV3RequestAuthority(
      sqlite,
      this.support,
      this.runtimeArtifactAuthority,
      this.runtimeScopeAuthority,
      this.questionAuthority,
      (runId, agentId) => this.requestIdsAttachedToRun(runId, agentId),
      input => this.createActivation(input),
    );
    this.runLifecycleAuthority = new CoordinationV3RunLifecycleAuthority(
      sqlite,
      this.support,
      this.questionAuthority,
      this.activationLifecycle,
      input => this.updateRequest(input),
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
      (requestId, now) => this.requestAuthority.reevaluateRequestJoins(requestId, now),
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
        this.runLifecycleAuthority.markRelatedRequestsOutcomeUnknown(
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

  publishAgentNextRunDelivery(
    input: PublishAgentNextRunDeliveryInput,
  ): PublishNextRunDeliveryResult {
    return this.communicationV4NextRunDeliveries.publishAgent(input);
  }

  publishOperatorNextRunDelivery(
    input: PublishOperatorNextRunDeliveryInput,
  ): PublishNextRunDeliveryResult {
    return this.communicationV4NextRunDeliveries.publishOperator(input);
  }

  operatorNextRunDeliveryReceipts(input: {
    projectId: string;
    conversationId: string;
    publisherUserId: string;
    limit?: number;
    now?: string;
  }): OperatorNextRunDeliveryReceipt[] {
    return this.communicationV4NextRunDeliveries.listOperatorReceipts(input);
  }

  communicationV4NextRunDelivery(
    deliveryId: string,
  ): CommunicationV4NextRunDelivery | undefined {
    return this.communicationV4NextRunDeliveries.get(deliveryId);
  }

  pendingCommunicationV4NextRunDeliveries(input: {
    projectId: string;
    conversationId: string;
    agentId: string;
    limit?: number;
    now?: string;
  }): CommunicationV4NextRunDelivery[] {
    return this.communicationV4NextRunDeliveries.pendingForNextRun(input);
  }

  markCommunicationV4NextRunDeliveriesDelivered(input: {
    projectId: string;
    conversationId: string;
    agentId: string;
    runId: string;
    deliveryIds: string[];
    now?: string;
  }): number {
    return this.communicationV4NextRunDeliveries.markDelivered(input);
  }

  maintainCommunicationV4NextRunDeliveries(
    now?: string,
  ): NextRunDeliveryMaintenanceResult {
    return this.communicationV4NextRunDeliveries.maintain(now);
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

  terminalActivationDisposition(activationId: string): {
    id: string;
    state: TerminalActivationV3View["state"];
    supersededByRetry: boolean;
  } | undefined {
    return this.activationReadModel.terminalActivationDisposition(activationId);
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

  runScopeKey(runId: string, agentId: string): string {
    return this.runContextReadModel.scopeKey(runId, agentId);
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

  providerBlockedState(agentId: string): import("@ponderosa/core").ProviderBlockedWorkDto | undefined {
    return this.schedulerStatusReadModel.providerBlockedState(agentId);
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
  requestSummariesForCommunications(
    projectId: string,
    communicationEventIds: string[],
  ): Map<string, import("@ponderosa/core").CoordinationRequestSummaryDto[]> {
    return this.readModel.requestSummariesForCommunications(projectId, communicationEventIds);
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
    operationGroupId: string;
    state: string;
    primaryAgentId: string;
    secondaryAgentId?: string;
    subtype?: string;
    completed?: number;
    total?: number;
    requesterAgentId?: string;
    recipientAgentId?: string;
    communicationEventId?: string;
    requestPreview?: string;
    hasUpdates?: boolean;
    latestUpdateKind?: import("@ponderosa/core").CoordinationRequestUpdateKind;
    latestUpdateAt?: string;
    hasResult?: boolean;
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

  /** Loads one scoped Request and its canonical update history on demand. */
  requestLifecycleDetails(input: {
    projectId: string;
    conversationId?: string;
    recordId: string;
  }): import("@ponderosa/core").CoordinationRequestLifecycleDto | undefined {
    return this.readModel.requestLifecycleDetails(input);
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
    return this.requestAuthority.updateRequest(input);
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
    this.requestAuthority.attachRequestCommunication(requestId, communicationEventId, projectId);
  }

  expireDue(now = new Date().toISOString()): { requests: number; joins: number } {
    return this.requestAuthority.expireDue(now);
  }

  /** On single-host startup every active lease owned by another server process
   * is orphaned. Pre-submission work is retryable; submitted or acknowledged
   * injections fail closed until an adapter can prove provider reconciliation. */
  recoverOrphanedRuns(workerId: string, now = new Date().toISOString()): { retried: number; outcomeUnknown: number } {
    return this.schedulerLeaseAuthority.recoverOrphanedRuns(workerId, now);
  }

  cancelJoin(joinId: string, ownerAgentId: string, now = new Date().toISOString()): boolean {
    return this.requestAuthority.cancelJoin(joinId, ownerAgentId, now);
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

  purgeCommunicationV4Conversation(conversationId: string): void {
    this.deletionAuthority.purgeCommunicationV4Conversation(conversationId);
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
    injectionId: string; runId: string; fencingToken: number; retryDelayMs?: number;
    preserveSteering?: boolean; now?: string;
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
    this.runLifecycleAuthority.markRunStarted(runId, fence, now);
  }

  setRunContextDisposition(
    runId: string,
    fence: number,
    disposition: "fresh_task" | "continued_session" | "reseeded",
    now = new Date().toISOString(),
  ): void {
    this.runLifecycleAuthority.setRunContextDisposition(runId, fence, disposition, now);
  }

  recordProviderInput(input: {
    executionId: string;
    schedulerRunId: string;
    fencingToken: number;
    agentId: string;
    projectId: string;
    prompt: string;
    systemPrompt?: string;
    sourceManifest: import("@ponderosa/core").ProviderInputSourceManifest;
    now?: string;
  }): void {
    this.runLifecycleAuthority.recordProviderInput(input);
  }

  preparePromptInjection(input: {
    injectionId: string; runId: string; fencingToken: number; prompt: string; now?: string;
  }): void {
    this.runLifecycleAuthority.preparePromptInjection(input);
  }

  activationIdsForInjection(injectionId: string, runId: string): string[] {
    return this.runLifecycleAuthority.activationIdsForInjection(injectionId, runId);
  }

  promptInjectionForActivation(runId: string, activationId: string): {
    id: string;
    kind: "turn" | "steer";
    state: string;
  } | undefined {
    return this.runLifecycleAuthority.promptInjectionForActivation(runId, activationId);
  }

  markPromptSubmitted(input: {
    injectionId: string; runId: string; fencingToken: number; providerSessionId?: string; now?: string;
  }): void {
    this.runLifecycleAuthority.markPromptSubmitted(input);
  }

  acknowledgePromptInjection(input: {
    injectionId: string; runId: string; fencingToken: number;
    providerTurnId?: string; providerSessionId?: string; now?: string;
  }): void {
    this.runLifecycleAuthority.acknowledgePromptInjection(input);
  }

  renewLease(runId: string, fence: number, workerId: string, leaseMs = 30_000, now = new Date().toISOString()): string {
    return this.runLifecycleAuthority.renewLease(runId, fence, workerId, leaseMs, now);
  }

  completeRun(runId: string, fence: number, now = new Date().toISOString()): void {
    this.runLifecycleAuthority.completeRun(runId, fence, now);
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
    return this.runLifecycleAuthority.failRun(input);
  }

  resumeProviderBlockedAgent(
    agentId: string,
    runtimeSelection: {
      activeEngine: string;
      model?: string;
      effort?: string;
    },
    now = new Date().toISOString(),
  ): { activationIds: string[]; resumed: number } {
    return this.runLifecycleAuthority.resumeProviderBlockedAgent(agentId, runtimeSelection, now);
  }

  cancelAgentRun(input: { agentId: string; idempotencyKey: string; expectedRunId?: string; now?: string }): CancellationResult {
    return this.runLifecycleAuthority.cancelAgentRun(input);
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

  resetExpiredTriggerBudgets(now = new Date().toISOString()): number {
    return this.triggerOccurrenceAuthority.resetExpiredTriggerBudgets(now);
  }

  requestContextRollover(input: Parameters<CoordinationV3ContextRolloverAuthority["request"]>[0]): ReturnType<CoordinationV3ContextRolloverAuthority["request"]> {
    return this.contextRolloverAuthority.request(input);
  }

  contextRollover(id: string): ContextRolloverV3 | undefined {
    return this.contextRolloverAuthority.get(id);
  }

  activeContextRollover(agentId: string): ContextRolloverV3 | undefined {
    return this.contextRolloverAuthority.activeForAgent(agentId);
  }

  contextRolloverForReplacementSession(agentId: string, replacementSessionId: string): ContextRolloverV3 | undefined {
    return this.contextRolloverAuthority.forReplacementSession(agentId, replacementSessionId);
  }

  contextRolloverForContinuationRun(runId: string, agentId: string): ContextRolloverV3 | undefined {
    return this.contextRolloverAuthority.forContinuationRun(runId, agentId);
  }

  contextRolloverRecoveryForRun(runId: string, agentId: string): ContextRolloverV3 | undefined {
    return this.contextRolloverAuthority.recoveryForRun(runId, agentId);
  }

  contextRolloverRecoveryForRequest(requestId: string): ContextRolloverV3 | undefined {
    return this.contextRolloverAuthority.recoveryForRequest(requestId);
  }

  activeContextRollovers(projectId?: string): ContextRolloverV3[] {
    return this.contextRolloverAuthority.active(projectId);
  }

  cancelledContextRolloverReplacements(): ContextRolloverV3[] {
    return this.contextRolloverAuthority.cancelledReplacements();
  }

  commitContextRolloverHandoff(id: string, handoffEventId: string, now?: string): ContextRolloverV3 {
    return this.contextRolloverAuthority.commitHandoff(id, handoffEventId, now);
  }

  beginContextRolloverRetirement(id: string, now?: string): ContextRolloverV3 {
    return this.contextRolloverAuthority.beginRetiring(id, now);
  }

  markContextRolloverVisibleResponseCommitted(agentId: string, sourceRunId: string, now?: string): ContextRolloverV3 | undefined {
    return this.contextRolloverAuthority.markVisibleResponseCommitted(agentId, sourceRunId, now);
  }

  prepareContextRolloverContinuation(input: { id: string; now?: string }): ContextRolloverV3 {
    return this.contextRolloverAuthority.prepareContinuation(input);
  }

  recordContextRolloverReplacementSession(continuationActivationId: string, replacementSessionId: string, now?: string): ContextRolloverV3 | undefined {
    return this.contextRolloverAuthority.recordReplacementSession(continuationActivationId, replacementSessionId, now);
  }

  observeContextRolloverReplacementOccupancy(id: string, replacementSessionId: string, usedTokens: number, now?: string): ContextRolloverV3 {
    return this.contextRolloverAuthority.observeReplacementOccupancy(id, replacementSessionId, usedTokens, now);
  }

  failContextRollover(id: string, state: "failed" | "outcome_unknown", error: string, now?: string): ContextRolloverV3 {
    return this.contextRolloverAuthority.fail(id, state, error, now);
  }

  private createActivation(input: CreateActivationV3Input): string {
    return this.activationFactory.create(input);
  }

}
