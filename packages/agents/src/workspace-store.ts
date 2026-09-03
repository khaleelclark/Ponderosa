import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ConversationDraftDto,
  DecisionDto,
  ConversationDraftConflictDto,
  ConversationDraftConflictListDto,
  UpdateWorkspacePreferencesRequest,
  WorkspaceEvent,
  WorkspaceEventEnvelope,
  WorkspaceNotificationCountProjectionDto,
  WorkspaceNotificationDto,
  WorkspaceNotificationProjectionDto,
  WorkspaceProjectNotificationProjectionDto,
  NotificationPreferencesDto,
  WorkspacePreferencesDto,
  WorkspaceResourceKind,
  WorkspaceResourceRecencyDto,
  WorkspaceResourceRecencyListDto,
  WebPushSubscriptionDto,
} from "@ponderosa/core";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import { workspaceEventsPath, workspaceInstancePath } from "./paths.js";

type CanonicalWorkspaceEvent = WorkspaceEventEnvelope & {
  mutation?:
    | { kind: "draft"; draft: ConversationDraftDto }
    | { kind: "draft_conflict"; conflict: ConversationDraftConflictDto }
    | { kind: "draft_deleted"; draftId: string }
    | { kind: "notification"; notification: WorkspaceNotificationDto; pushTargets?: Array<{ deviceId: string; subscriptionUpdatedAt: string }> }
    | { kind: "notifications_read"; conversationId: string; readAt: string }
    | { kind: "notifications_read_ids"; notificationIds: string[]; readAt: string }
    | { kind: "notifications_acknowledged_ids"; notificationIds: string[]; acknowledgedAt: string }
    | { kind: "notifications_read_all"; readAt: string }
    | { kind: "notifications_cleared"; notificationIds: string[] }
    | { kind: "notifications_dismissed"; notificationIds: string[]; at: string }
    | { kind: "notification_status"; notificationId: string; status: "resolved" | "dismissed"; at: string }
    | { kind: "decision"; decision: DecisionDto; idempotencyKey: string }
    | { kind: "push_subscription"; subscription?: WebPushSubscriptionDto; deviceId: string; replacedDeviceIds?: string[] }
    | { kind: "push_delivery"; delivery: PushDeliveryRecord };
};

export interface DecisionEventProjection {
  kind: "decision" | "decision_response";
  id: string;
  createdAt: string;
  decision: DecisionDto;
}

export interface PushDeliveryRecord {
  notificationId: string;
  deviceId: string;
  subscriptionUpdatedAt: string;
  status: "pending" | "delivered" | "abandoned";
  attempts: number;
  nextAttemptAt: string;
  deliveredAt?: string;
  lastError?: string;
}

const DEFAULT_PREFERENCES: WorkspacePreferencesDto = {
  projectSort: "last_used",
  projectOrder: [],
  homeOrder: [],
  homeSort: "last_used",
  chatOrder: [],
  chatSort: "last_used",
  agentOrder: [],
  agentSort: "last_used",
  triggerOrder: [],
  triggerSort: "last_used",
  starredResourceIds: [],
  starredProjectIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 288,
  notifications: { directResponses: true, broadcasts: true },
  fontFamily: "inter",
  providerAvailability: {},
  engineDefaults: {},
  claudeModelOptions: [],
  globalInstructions: "",
  maxConcurrentAgentRuns: 8,
  contextRolloverEnabled: false,
  contextRolloverTokens: 150_000,
  contextRolloverWindowFraction: 0.7,
  onboardingCompletedAt: null,
  profile: { displayName: "User", handle: "operator", avatarId: "default-user" },
  updatedAt: new Date(0).toISOString(),
};

function isOpenAttentionNotification(item: WorkspaceNotificationDto): boolean {
  return (item.status ?? "open") === "open" && (
    item.kind === "decision" ||
    item.kind === "operational" ||
    item.severity === "attention" ||
    item.severity === "urgent"
  );
}

function isOpenNotificationUpdate(item: WorkspaceNotificationDto): boolean {
  return (item.status ?? "open") === "open" && !isOpenAttentionNotification(item);
}

type NotificationLiveKind = "attention" | "update";

function notificationLiveKind(item: WorkspaceNotificationDto): NotificationLiveKind | undefined {
  if (item.kind === "collaboration" || (item.status ?? "open") !== "open") return undefined;
  if (isOpenAttentionNotification(item)) return "attention";
  return !item.readAt && isOpenNotificationUpdate(item) ? "update" : undefined;
}

const IMPORTANT_MESSAGE_NOTIFICATION_KINDS = new Set<WorkspaceNotificationDto["kind"]>([
  "direct_responses",
  "everyone",
]);

const MESSAGE_NOTIFICATION_KINDS = new Set<WorkspaceNotificationDto["kind"]>([
  ...IMPORTANT_MESSAGE_NOTIFICATION_KINDS,
  "broadcasts",
]);

function unreadProjectionKind(
  item: WorkspaceNotificationDto,
): "important" | "ordinary" | undefined {
  if ((item.status ?? "open") !== "open" || item.kind === "collaboration") return undefined;
  if (isOpenAttentionNotification(item)) return item.acknowledgedAt ? undefined : "important";
  if (item.readAt || !MESSAGE_NOTIFICATION_KINDS.has(item.kind)) return undefined;
  return IMPORTANT_MESSAGE_NOTIFICATION_KINDS.has(item.kind) ? "important" : "ordinary";
}

interface NotificationProjectionAccumulator {
  importantIds: Set<string>;
  ordinaryIds: Set<string>;
}

function emptyNotificationProjectionAccumulator(): NotificationProjectionAccumulator {
  return { importantIds: new Set<string>(), ordinaryIds: new Set<string>() };
}

function addNotificationProjection(
  accumulator: NotificationProjectionAccumulator,
  item: WorkspaceNotificationDto,
  kind: "important" | "ordinary",
): void {
  if (kind === "important") {
    accumulator.importantIds.add(item.id);
    accumulator.ordinaryIds.delete(item.id);
  } else if (!accumulator.importantIds.has(item.id)) {
    accumulator.ordinaryIds.add(item.id);
  }
}

function notificationProjectionCounts(
  accumulator: NotificationProjectionAccumulator,
): WorkspaceNotificationCountProjectionDto {
  return {
    importantCount: accumulator.importantIds.size,
    ordinaryCount: accumulator.ordinaryIds.size,
    totalCount: accumulator.importantIds.size + accumulator.ordinaryIds.size,
  };
}

export interface WorkspaceNotificationPageCursor {
  createdAt: string;
  id: string;
}

export interface WorkspaceNotificationPage {
  items: WorkspaceNotificationDto[];
  openActionCount: number;
  unacknowledgedActionCount: number;
  unreadUpdateCount: number;
  nextCursor?: WorkspaceNotificationPageCursor;
}

function compareNotificationsNewestFirst(
  left: Pick<WorkspaceNotificationDto, "createdAt" | "id">,
  right: Pick<WorkspaceNotificationDto, "createdAt" | "id">,
): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

/** Canonical workspace/user event log with rebuildable in-memory projections. */
export class WorkspaceStore {
  private readonly file: string;
  private readonly instance: string;
  private readonly events: CanonicalWorkspaceEvent[];
  private readonly drafts = new Map<string, ConversationDraftDto>();
  private readonly draftConflicts = new Map<string, ConversationDraftConflictDto[]>();
  private readonly notifications = new Map<string, WorkspaceNotificationDto>();
  private readonly notificationsByDedupeKey = new Map<string, WorkspaceNotificationDto>();
  private readonly openOperationalNotificationsByDedupeKey = new Map<string, WorkspaceNotificationDto>();
  private readonly activeNotifications: WorkspaceNotificationDto[] = [];
  private notificationOpenActionCount = 0;
  private notificationUnacknowledgedActionCount = 0;
  private notificationUnreadUpdateCount = 0;
  private readonly unreadNotificationIdsByCommunication = new Map<string, Set<string>>();
  private readonly unreadNotificationIdsByConversation = new Map<string, Set<string>>();
  private readonly decisions = new Map<string, DecisionDto>();
  private readonly decisionIdempotency = new Map<string, string>();
  private readonly decisionIdsByProject = new Map<string, string[]>();
  private readonly decisionIdsByConversation = new Map<string, string[]>();
  private readonly decisionIdsByAgent = new Map<string, string[]>();
  private readonly decisionIdsByConversationAgent = new Map<string, string[]>();
  private readonly decisionIdsByRun = new Map<string, Set<string>>();
  private readonly decisionEventIds: string[] = [];
  private readonly decisionEventIdsByProject = new Map<string, string[]>();
  private readonly decisionEventIdsByConversation = new Map<string, string[]>();
  private readonly pushSubscriptions = new Map<string, WebPushSubscriptionDto>();
  private readonly pushDeliveries = new Map<string, PushDeliveryRecord>();
  private readonly deletedProjectIds = new Set<string>();
  private readonly projectDeletionEvents = new Map<string, WorkspaceEventEnvelope>();
  private readonly queuedMessageChanges = new Set<string>();
  private readonly resourceRecency = new Map<string, WorkspaceResourceRecencyDto>();
  private readonly resourceRecencyLinks = new Map<
    string,
    { newer?: string; older?: string }
  >();
  private newestResourceRecencyKey?: string;
  private oldestResourceRecencyKey?: string;
  private preferences = DEFAULT_PREFERENCES;

  private draftKey(conversationId: string, ownerId = "legacy"): string {
    return `${conversationId}\u0000${ownerId}`;
  }

  constructor(dataDir: string) {
    this.file = workspaceEventsPath(dataDir);
    const instanceFile = workspaceInstancePath(dataDir);
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(instanceFile)) writeFileSync(instanceFile, `${randomUUID()}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(instanceFile, 0o600);
    this.instance = readFileSync(instanceFile, "utf8").trim();
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    chmodSync(this.file, 0o600);
    this.events = readRepairableJsonl<CanonicalWorkspaceEvent>(this.file, "workspace event log", true);
    for (const event of this.events) this.project(event);
  }

  private notificationSearchIndexEligible(item: WorkspaceNotificationDto): boolean {
    return notificationLiveKind(item) === "update";
  }

  private updateNotificationSearchIndex(item: WorkspaceNotificationDto, add: boolean): void {
    if (!this.notificationSearchIndexEligible(item)) return;
    for (const [key, index] of [
      [item.communicationEventId, this.unreadNotificationIdsByCommunication],
      [item.conversationId, this.unreadNotificationIdsByConversation],
    ] as const) {
      if (!key) continue;
      if (add) {
        const ids = index.get(key) ?? new Set<string>();
        ids.add(item.id);
        index.set(key, ids);
      } else {
        const ids = index.get(key);
        ids?.delete(item.id);
        if (ids?.size === 0) index.delete(key);
      }
    }
  }

  private setNotification(item: WorkspaceNotificationDto): void {
    const current = this.notifications.get(item.id);
    if (current) {
      this.updateNotificationSearchIndex(current, false);
      this.removeActiveNotification(current);
      if (current.dedupeKey && this.notificationsByDedupeKey.get(current.dedupeKey)?.id === current.id) {
        this.notificationsByDedupeKey.delete(current.dedupeKey);
      }
      if (current.dedupeKey && this.openOperationalNotificationsByDedupeKey.get(current.dedupeKey)?.id === current.id) {
        this.openOperationalNotificationsByDedupeKey.delete(current.dedupeKey);
      }
    }
    this.notifications.set(item.id, item);
    if (item.dedupeKey) this.notificationsByDedupeKey.set(item.dedupeKey, item);
    if (item.kind === "operational" && item.dedupeKey && (item.status ?? "open") === "open") {
      this.openOperationalNotificationsByDedupeKey.set(item.dedupeKey, item);
    }
    this.updateNotificationSearchIndex(item, true);
    this.insertActiveNotification(item);
  }

  private deleteNotification(id: string): void {
    const current = this.notifications.get(id);
    if (current) {
      this.updateNotificationSearchIndex(current, false);
      this.removeActiveNotification(current);
      if (current.dedupeKey && this.notificationsByDedupeKey.get(current.dedupeKey)?.id === current.id) {
        this.notificationsByDedupeKey.delete(current.dedupeKey);
      }
      if (current.dedupeKey && this.openOperationalNotificationsByDedupeKey.get(current.dedupeKey)?.id === current.id) {
        this.openOperationalNotificationsByDedupeKey.delete(current.dedupeKey);
      }
    }
    this.notifications.delete(id);
  }

  private removeActiveNotification(item: WorkspaceNotificationDto): void {
    const kind = notificationLiveKind(item);
    if (!kind) return;
    const index = this.activeNotifications.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) return;
    this.activeNotifications.splice(index, 1);
    if (kind === "attention") {
      this.notificationOpenActionCount -= 1;
      if (!item.acknowledgedAt) this.notificationUnacknowledgedActionCount -= 1;
    }
    else this.notificationUnreadUpdateCount -= 1;
  }

  private insertActiveNotification(item: WorkspaceNotificationDto): void {
    const kind = notificationLiveKind(item);
    if (!kind) return;
    let low = 0;
    let high = this.activeNotifications.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareNotificationsNewestFirst(this.activeNotifications[middle]!, item) <= 0) low = middle + 1;
      else high = middle;
    }
    this.activeNotifications.splice(low, 0, item);
    if (kind === "attention") {
      this.notificationOpenActionCount += 1;
      if (!item.acknowledgedAt) this.notificationUnacknowledgedActionCount += 1;
    }
    else this.notificationUnreadUpdateCount += 1;
  }

  private project(record: CanonicalWorkspaceEvent): void {
    this.projectResourceRecency(record);
    this.projectDeletedProjectNotifications(record);
    if (record.event.type === "queued_message_changed") {
      this.queuedMessageChanges.add([
        record.event.conversationId,
        record.event.deliveryId,
        record.event.action,
      ].join("\0"));
    }
    if (record.event.type === "preferences_updated") {
      const preferences = record.event.preferences;
      this.preferences = {
        ...DEFAULT_PREFERENCES,
        ...preferences,
        notifications: normalizeNotifications(preferences.notifications),
        projectOrder: preferences.projectOrder ?? [],
        homeOrder: preferences.homeOrder ?? [],
        homeSort: preferences.homeSort ?? "last_used",
        chatOrder: preferences.chatOrder ?? [],
        chatSort: preferences.chatSort ?? "last_used",
        agentOrder: preferences.agentOrder ?? [],
        agentSort: preferences.agentSort ?? "last_used",
        triggerOrder: preferences.triggerOrder ?? [],
        triggerSort: preferences.triggerSort ?? "last_used",
        starredResourceIds: preferences.starredResourceIds ?? [],
        starredProjectIds: preferences.starredProjectIds ?? [],
        providerAvailability: preferences.providerAvailability ?? {},
        engineDefaults: preferences.engineDefaults ?? {},
        claudeModelOptions: normalizeClaudeModelOptions(preferences.claudeModelOptions),
        globalInstructions: preferences.globalInstructions ?? "",
        maxConcurrentAgentRuns: preferences.maxConcurrentAgentRuns ?? DEFAULT_PREFERENCES.maxConcurrentAgentRuns,
        contextRolloverEnabled: preferences.contextRolloverEnabled ?? DEFAULT_PREFERENCES.contextRolloverEnabled,
        contextRolloverTokens: clampContextRolloverTokens(
          preferences.contextRolloverTokens ?? DEFAULT_PREFERENCES.contextRolloverTokens,
        ),
        contextRolloverWindowFraction: clampContextRolloverWindowFraction(
          preferences.contextRolloverWindowFraction ?? DEFAULT_PREFERENCES.contextRolloverWindowFraction,
        ),
        onboardingCompletedAt: preferences.onboardingCompletedAt ?? null,
        profile: normalizeProfile(preferences.profile),
      };
    }
    if (record.mutation?.kind === "draft") this.drafts.set(this.draftKey(record.mutation.draft.conversationId, record.mutation.draft.ownerId), record.mutation.draft);
    if (record.mutation?.kind === "draft_conflict") {
      const conversationId = record.mutation.conflict.current.conversationId;
      const key = this.draftKey(conversationId, record.mutation.conflict.current.ownerId);
      const conflicts = this.draftConflicts.get(key) ?? [];
      conflicts.push(record.mutation.conflict);
      // Keep the canonical log complete, but bound the projection used by the UI.
      this.draftConflicts.set(key, conflicts.slice(-20));
    }
    if (record.mutation?.kind === "draft_deleted") {
      const prefix = `${record.mutation.draftId}\u0000`;
      for (const key of [...this.drafts.keys()]) if (key.startsWith(prefix)) this.drafts.delete(key);
      for (const key of [...this.draftConflicts.keys()]) if (key.startsWith(prefix)) this.draftConflicts.delete(key);
    }
    if (record.mutation?.kind === "notification") {
      let notification = this.deletedProjectNotification(
        record.mutation.notification,
        record.ts,
      );
      const canonicalDecision = notification.decision
        ? this.decisions.get(notification.decision.id)
        : undefined;
      if (canonicalDecision && canonicalDecision.status !== "pending") {
        notification = {
          ...notification,
          decision: { ...notification.decision!, status: canonicalDecision.status },
          status: "resolved",
          resolvedAt: canonicalDecision.updatedAt,
        };
      }
      this.setNotification(notification);
      for (const target of record.mutation.pushTargets ?? []) {
        if ((notification.status ?? "open") !== "open") continue;
        const key = this.pushDeliveryKey(notification.id, target.deviceId);
        if (!this.pushDeliveries.has(key)) this.pushDeliveries.set(key, {
          notificationId: notification.id,
          deviceId: target.deviceId,
          subscriptionUpdatedAt: target.subscriptionUpdatedAt,
          status: "pending",
          attempts: 0,
          nextAttemptAt: record.ts,
        });
      }
    }
    if (record.mutation?.kind === "notifications_read") {
      for (const item of this.notifications.values()) {
        if (item.conversationId === record.mutation.conversationId && !item.readAt) {
          this.setNotification({ ...item, readAt: record.mutation.readAt });
        }
      }
    }
    if (record.mutation?.kind === "notifications_read_ids") {
      for (const notificationId of record.mutation.notificationIds) {
        const current = this.notifications.get(notificationId);
        if (current && !current.readAt) this.setNotification({ ...current, readAt: record.mutation.readAt });
      }
    }
    if (record.mutation?.kind === "notifications_acknowledged_ids") {
      for (const notificationId of record.mutation.notificationIds) {
        const current = this.notifications.get(notificationId);
        if (current && isOpenAttentionNotification(current) && !current.acknowledgedAt) {
          this.setNotification({ ...current, acknowledgedAt: record.mutation.acknowledgedAt });
        }
      }
    }
    if (record.mutation?.kind === "notifications_read_all") {
      for (const item of this.notifications.values()) {
        if (!item.readAt) this.setNotification({ ...item, readAt: record.mutation.readAt });
      }
    }
    if (record.mutation?.kind === "notifications_dismissed") {
      for (const notificationId of record.mutation.notificationIds) {
        const current = this.notifications.get(notificationId);
        if (current) this.setNotification({ ...current, status: "dismissed", resolvedAt: record.mutation.at, readAt: current.readAt ?? record.mutation.at });
        for (const key of this.pushDeliveries.keys()) {
          if (key.startsWith(`${notificationId}\u0000`)) this.pushDeliveries.delete(key);
        }
      }
    }
    if (record.mutation?.kind === "notifications_cleared") {
      for (const notificationId of record.mutation.notificationIds) {
        this.deleteNotification(notificationId);
        for (const key of this.pushDeliveries.keys()) {
          if (key.startsWith(`${notificationId}\u0000`)) this.pushDeliveries.delete(key);
        }
      }
    }
    if (record.mutation?.kind === "notification_status") {
      const current = this.notifications.get(record.mutation.notificationId);
      if (current) this.setNotification({
        ...current,
        status: record.mutation.status,
        resolvedAt: record.mutation.at,
      });
    }
    if (record.mutation?.kind === "decision") {
      const previous = this.decisions.get(record.mutation.decision.id);
      const isNew = !previous;
      this.decisions.set(record.mutation.decision.id, record.mutation.decision);
      this.decisionIdempotency.set(record.mutation.idempotencyKey, record.mutation.decision.id);
      if (isNew) {
        this.indexDecision(record.mutation.decision);
        this.indexDecisionEvent(record.mutation.decision, "decision");
      }
      if (record.mutation.decision.response?.respondedAt && !previous?.response?.respondedAt) {
        this.indexDecisionEvent(record.mutation.decision, "decision_response");
      }
      for (const notification of this.notifications.values()) {
        if (notification.decision?.id !== record.mutation.decision.id) continue;
        this.setNotification({
          ...notification,
          decision: { ...notification.decision, status: record.mutation.decision.status },
          ...(record.mutation.decision.status === "pending" ? {} : {
            status: "resolved" as const,
            resolvedAt: record.mutation.decision.updatedAt,
          }),
        });
      }
    }
    if (record.mutation?.kind === "push_subscription") {
      for (const replacedDeviceId of record.mutation.replacedDeviceIds ?? []) this.pushSubscriptions.delete(replacedDeviceId);
      if (record.mutation.subscription) this.pushSubscriptions.set(record.mutation.deviceId, record.mutation.subscription);
      else this.pushSubscriptions.delete(record.mutation.deviceId);
    }
    if (record.mutation?.kind === "push_delivery") {
      const delivery = record.mutation.delivery;
      this.pushDeliveries.set(this.pushDeliveryKey(delivery.notificationId, delivery.deviceId), delivery);
    }
  }

  private deletedProjectNotification(
    notification: WorkspaceNotificationDto,
    at: string,
  ): WorkspaceNotificationDto {
    if (!notification.projectId || !this.deletedProjectIds.has(notification.projectId)) {
      return notification;
    }
    // Deletion cleanup is workspace-owned after its Project has gone. Keep the
    // alert current without retaining a dead Project destination.
    if (notification.dedupeKey?.startsWith("project-deletion:")) {
      const { projectId: _deletedProjectId, ...workspaceNotification } = notification;
      return workspaceNotification;
    }
    return {
      ...notification,
      status: "resolved",
      readAt: notification.readAt ?? at,
      resolvedAt: notification.resolvedAt ?? at,
    };
  }

  /** Project lifecycle is the durable boundary for retaining historical
   * notifications without leaving deleted destinations unread or actionable. */
  private projectDeletedProjectNotifications(record: CanonicalWorkspaceEvent): void {
    const event = record.event;
    if (event.type !== "project_changed") return;
    if (event.action === "created") {
      this.deletedProjectIds.delete(event.projectId);
      this.projectDeletionEvents.delete(event.projectId);
      return;
    }
    if (event.action !== "deleted") return;
    this.deletedProjectIds.add(event.projectId);
    this.projectDeletionEvents.set(event.projectId, record);
    for (const notification of this.notifications.values()) {
      if (notification.projectId !== event.projectId) continue;
      const reconciled = this.deletedProjectNotification(notification, record.ts);
      this.setNotification(reconciled);
      if ((reconciled.status ?? "open") === "open") continue;
      for (const key of this.pushDeliveries.keys()) {
        if (key.startsWith(`${notification.id}\u0000`)) this.pushDeliveries.delete(key);
      }
    }
  }

  private projectResourceRecency(record: CanonicalWorkspaceEvent): void {
    const event = record.event;
    if (event.type === "resource_used") {
      this.touchResourceRecency(event.kind, event.resourceId, record.ts);
      return;
    }
    if (event.type === "project_changed") {
      if (event.action === "deleted") {
        this.deleteResourceRecency(`project:${event.projectId}`);
      } else if (event.action === "created" || event.action === "used") {
        this.touchResourceRecency("project", event.projectId, record.ts);
      }
      return;
    }
    if (event.type === "conversation_changed") {
      if (event.action === "deleted") {
        this.deleteResourceRecency(`conversation:${event.conversationId}`);
      } else if (
        event.action === "created"
        || event.action === "used"
        || event.action === "message"
      ) {
        this.touchResourceRecency("conversation", event.conversationId, record.ts);
      }
      return;
    }
    if (
      event.type === "agent_event"
      || event.type === "coordination_changed"
    ) {
      this.touchResourceRecency("agent", event.agentId, record.ts);
      return;
    }
    if (event.type === "trigger_changed") {
      if (event.action === "deleted") {
        this.deleteResourceRecency(`trigger:${event.triggerId}`);
      } else if (event.action === "created" || event.action === "occurrence") {
        this.touchResourceRecency("trigger", event.triggerId, record.ts);
      }
    }
  }

  private touchResourceRecency(
    kind: WorkspaceResourceKind,
    resourceId: string,
    lastUsedAt: string,
  ): WorkspaceResourceRecencyDto {
    const resourceKey = `${kind}:${resourceId}` as const;
    const current = this.resourceRecency.get(resourceKey);
    if (current && current.lastUsedAt >= lastUsedAt) return current;
    const next: WorkspaceResourceRecencyDto = {
      resourceKey,
      kind,
      resourceId,
      lastUsedAt,
    };
    this.deleteResourceRecency(resourceKey);
    this.resourceRecency.set(resourceKey, next);
    this.insertResourceRecency(resourceKey);
    return next;
  }

  private compareResourceRecencyKeys(leftKey: string, rightKey: string): number {
    const left = this.resourceRecency.get(leftKey)!;
    const right = this.resourceRecency.get(rightKey)!;
    return right.lastUsedAt.localeCompare(left.lastUsedAt)
      || left.resourceKey.localeCompare(right.resourceKey);
  }

  private insertResourceRecency(resourceKey: string): void {
    const head = this.newestResourceRecencyKey;
    if (!head) {
      this.newestResourceRecencyKey = resourceKey;
      this.oldestResourceRecencyKey = resourceKey;
      this.resourceRecencyLinks.set(resourceKey, {});
      return;
    }

    // Appended workspace events normally move a resource directly to the head.
    // Only equal-time tie ordering or repaired legacy input needs a short walk.
    let olderKey: string | undefined = head;
    while (
      olderKey
      && this.compareResourceRecencyKeys(resourceKey, olderKey) > 0
    ) {
      olderKey = this.resourceRecencyLinks.get(olderKey)?.older;
    }
    if (!olderKey) {
      const tail = this.oldestResourceRecencyKey!;
      this.resourceRecencyLinks.get(tail)!.older = resourceKey;
      this.resourceRecencyLinks.set(resourceKey, { newer: tail });
      this.oldestResourceRecencyKey = resourceKey;
      return;
    }

    const newerKey = this.resourceRecencyLinks.get(olderKey)?.newer;
    this.resourceRecencyLinks.set(resourceKey, { newer: newerKey, older: olderKey });
    this.resourceRecencyLinks.get(olderKey)!.newer = resourceKey;
    if (newerKey) this.resourceRecencyLinks.get(newerKey)!.older = resourceKey;
    else this.newestResourceRecencyKey = resourceKey;
  }

  private deleteResourceRecency(resourceKey: string): void {
    const links = this.resourceRecencyLinks.get(resourceKey);
    if (links) {
      if (links.newer) this.resourceRecencyLinks.get(links.newer)!.older = links.older;
      else this.newestResourceRecencyKey = links.older;
      if (links.older) this.resourceRecencyLinks.get(links.older)!.newer = links.newer;
      else this.oldestResourceRecencyKey = links.newer;
      this.resourceRecencyLinks.delete(resourceKey);
    }
    this.resourceRecency.delete(resourceKey);
  }

  private decisionOrder(leftId: string, rightId: string): number {
    const left = this.decisions.get(leftId)!;
    const right = this.decisions.get(rightId)!;
    return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
  }

  private insertDecisionId(index: Map<string, string[]>, key: string, decisionId: string): void {
    const ids = index.get(key) ?? [];
    ids.push(decisionId);
    ids.sort((left, right) => this.decisionOrder(left, right));
    index.set(key, ids);
  }

  private indexDecision(decision: DecisionDto): void {
    this.insertDecisionId(this.decisionIdsByProject, decision.projectId, decision.id);
    this.insertDecisionId(this.decisionIdsByAgent, decision.agentId, decision.id);
    if (decision.conversationId) {
      this.insertDecisionId(this.decisionIdsByConversation, decision.conversationId, decision.id);
      this.insertDecisionId(
        this.decisionIdsByConversationAgent,
        `${decision.conversationId}\u0000${decision.agentId}`,
        decision.id,
      );
    }
    const runIds = this.decisionIdsByRun.get(decision.runId) ?? new Set<string>();
    runIds.add(decision.id);
    this.decisionIdsByRun.set(decision.runId, runIds);
  }

  private decisionEventId(decisionId: string, kind: DecisionEventProjection["kind"]): string {
    return kind === "decision" ? `decision:${decisionId}` : `decision-response:${decisionId}`;
  }

  private decisionEventForId(eventId: string): DecisionEventProjection | undefined {
    const response = eventId.startsWith("decision-response:");
    const decisionId = eventId.slice(response ? "decision-response:".length : "decision:".length);
    const decision = this.decisions.get(decisionId);
    if (!decision) return undefined;
    const createdAt = response ? decision.response?.respondedAt : decision.createdAt;
    if (!createdAt) return undefined;
    return {
      kind: response ? "decision_response" : "decision",
      id: eventId,
      createdAt,
      decision,
    };
  }

  private decisionEventOrder(leftId: string, rightId: string): number {
    const left = this.decisionEventForId(leftId)!;
    const right = this.decisionEventForId(rightId)!;
    return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
  }

  private insertDecisionEventId(index: string[], eventId: string): void {
    if (index.includes(eventId)) return;
    index.push(eventId);
    index.sort((left, right) => this.decisionEventOrder(left, right));
  }

  private indexDecisionEvent(decision: DecisionDto, kind: DecisionEventProjection["kind"]): void {
    const eventId = this.decisionEventId(decision.id, kind);
    this.insertDecisionEventId(this.decisionEventIds, eventId);
    const projectIds = this.decisionEventIdsByProject.get(decision.projectId) ?? [];
    this.insertDecisionEventId(projectIds, eventId);
    this.decisionEventIdsByProject.set(decision.projectId, projectIds);
    if (decision.conversationId) {
      const conversationIds = this.decisionEventIdsByConversation.get(decision.conversationId) ?? [];
      this.insertDecisionEventId(conversationIds, eventId);
      this.decisionEventIdsByConversation.set(decision.conversationId, conversationIds);
    }
  }

  append(event: WorkspaceEvent, mutation?: CanonicalWorkspaceEvent["mutation"]): WorkspaceEventEnvelope {
    const record: CanonicalWorkspaceEvent = {
      id: (this.events.at(-1)?.id ?? 0) + 1,
      ts: new Date().toISOString(),
      event,
      ...(mutation ? { mutation } : {}),
    };
    appendFsyncedJsonl(this.file, [record]);
    this.events.push(record);
    this.project(record);
    return record;
  }

  /** Materialize an irreversible Project receipt in the durable workspace log.
   * Returning the original envelope makes publication retries idempotent. */
  reconcileProjectDeletion(projectId: string): WorkspaceEventEnvelope {
    const existing = this.projectDeletionEvents.get(projectId);
    if (existing) return existing;
    return this.append({ type: "project_changed", projectId, action: "deleted" });
  }

  readSince(id: number): WorkspaceEventEnvelope[] {
    // Reconnects usually ask for a small tail of a long canonical log. Locate
    // that tail without rescanning every prior event.
    let low = 0;
    let high = this.events.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.events[middle]!.id <= id) low = middle + 1;
      else high = middle;
    }
    return this.events.slice(low).map(({ mutation: _mutation, ...event }) => event);
  }

  cursor(): number { return this.events.at(-1)?.id ?? 0; }

  hasQueuedMessageChange(input: {
    conversationId: string;
    deliveryId: string;
    action: Extract<WorkspaceEvent, { type: "queued_message_changed" }>["action"];
  }): boolean {
    return this.queuedMessageChanges.has([
      input.conversationId,
      input.deliveryId,
      input.action,
    ].join("\0"));
  }

  instanceId(): string { return this.instance; }

  getPreferences(): WorkspacePreferencesDto { return this.preferences; }

  listResourceRecency(limit?: number): WorkspaceResourceRecencyListDto {
    const starred = new Set([
      ...(this.preferences.starredResourceIds ?? []),
      ...this.preferences.starredProjectIds.map(id => `project:${id}`),
    ]);
    const selected = new Map<string, WorkspaceResourceRecencyDto>();
    if (limit !== undefined) {
      for (const resourceKey of starred) {
        const resource = this.resourceRecency.get(resourceKey);
        if (resource) selected.set(resourceKey, resource);
      }
    }

    let unstarredCount = 0;
    let truncated = false;
    let resourceKey = this.newestResourceRecencyKey;
    while (resourceKey) {
      const resource = this.resourceRecency.get(resourceKey)!;
      if (limit === undefined) {
        selected.set(resourceKey, resource);
      } else if (!starred.has(resourceKey)) {
        if (unstarredCount >= limit) {
          truncated = true;
          break;
        }
        selected.set(resourceKey, resource);
        unstarredCount += 1;
      }
      resourceKey = this.resourceRecencyLinks.get(resourceKey)?.older;
    }

    const resources = [...selected.values()].sort(
      (left, right) =>
        right.lastUsedAt.localeCompare(left.lastUsedAt)
        || left.resourceKey.localeCompare(right.resourceKey),
    );
    return {
      resources,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  markResourceUsed(
    kind: WorkspaceResourceKind,
    resourceId: string,
  ): WorkspaceResourceRecencyDto {
    const record = this.append({ type: "resource_used", kind, resourceId });
    return this.resourceRecency.get(`${kind}:${resourceId}`) ?? {
      resourceKey: `${kind}:${resourceId}`,
      kind,
      resourceId,
      lastUsedAt: record.ts,
    };
  }

  updatePreferences(patch: UpdateWorkspacePreferencesRequest): WorkspacePreferencesDto {
    const notifications = patch.notifications ? normalizeNotifications(patch.notifications) : this.preferences.notifications;
    const preferences: WorkspacePreferencesDto = {
      ...this.preferences,
      ...patch,
      notifications,
      projectOrder: patch.projectOrder ?? this.preferences.projectOrder,
      homeOrder: patch.homeOrder ?? this.preferences.homeOrder,
      homeSort: patch.homeSort ?? this.preferences.homeSort,
      chatOrder: patch.chatOrder ?? this.preferences.chatOrder,
      chatSort: patch.chatSort ?? this.preferences.chatSort,
      agentOrder: patch.agentOrder ?? this.preferences.agentOrder,
      agentSort: patch.agentSort ?? this.preferences.agentSort,
      triggerOrder: patch.triggerOrder ?? this.preferences.triggerOrder,
      triggerSort: patch.triggerSort ?? this.preferences.triggerSort,
      starredResourceIds: patch.starredResourceIds ?? this.preferences.starredResourceIds,
      starredProjectIds: patch.starredProjectIds ?? this.preferences.starredProjectIds,
      providerAvailability: patch.providerAvailability ?? this.preferences.providerAvailability,
      engineDefaults: patch.engineDefaults ?? this.preferences.engineDefaults,
      claudeModelOptions: patch.claudeModelOptions === undefined
        ? this.preferences.claudeModelOptions
        : normalizeClaudeModelOptions(patch.claudeModelOptions),
      globalInstructions: (patch.globalInstructions ?? this.preferences.globalInstructions).slice(0, 100_000),
      maxConcurrentAgentRuns: patch.maxConcurrentAgentRuns ?? this.preferences.maxConcurrentAgentRuns,
      contextRolloverEnabled: patch.contextRolloverEnabled ?? this.preferences.contextRolloverEnabled,
      contextRolloverTokens: clampContextRolloverTokens(
        patch.contextRolloverTokens ?? this.preferences.contextRolloverTokens,
      ),
      contextRolloverWindowFraction: clampContextRolloverWindowFraction(
        patch.contextRolloverWindowFraction ?? this.preferences.contextRolloverWindowFraction,
      ),
      onboardingCompletedAt: patch.onboardingCompletedAt === undefined ? this.preferences.onboardingCompletedAt : patch.onboardingCompletedAt,
      profile: patch.profile ? normalizeProfile(patch.profile) : this.preferences.profile,
      sidebarWidth: Math.max(220, Math.min(520, Math.round(patch.sidebarWidth ?? this.preferences.sidebarWidth))),
      updatedAt: new Date().toISOString(),
    };
    this.append({ type: "preferences_updated", preferences });
    return preferences;
  }

  getDraft(conversationId: string, ownerId = "legacy"): ConversationDraftDto {
    return this.drafts.get(this.draftKey(conversationId, ownerId)) ?? { conversationId, ownerId, text: "", attachmentIds: [], revision: 0, updatedAt: new Date(0).toISOString(), clientId: "" };
  }

  putDraft(conversationId: string, input: { text: string; attachmentIds: string[]; mentionBindings?: ConversationDraftDto["mentionBindings"]; expectedRevision: number; clientId: string; ownerId?: string }): ConversationDraftDto {
    const ownerId = input.ownerId ?? "legacy";
    const current = this.getDraft(conversationId, ownerId);
    const attachmentIds = [...new Set(input.attachmentIds)];
    const mentionBindings = input.mentionBindings ?? [];
    if (current.text === input.text &&
        JSON.stringify(current.attachmentIds) === JSON.stringify(attachmentIds) &&
        JSON.stringify(current.mentionBindings ?? []) === JSON.stringify(mentionBindings)) return current;
    // A page can lose a successful response while its serialized write chain
    // continues. Its next write is safe to fast-forward because page client
    // identities are not shared with duplicated or restored browser pages.
    const provenSamePage = input.clientId.startsWith("page:")
      && current.clientId === input.clientId;
    if (current.revision !== input.expectedRevision && !provenSamePage) {
      const displaced: ConversationDraftConflictDto["displaced"] = {
        conversationId,
        text: input.text,
        attachmentIds,
        mentionBindings,
        clientId: input.clientId,
        capturedAt: new Date().toISOString(),
      };
      const conflict: ConversationDraftConflictDto = { current, displaced };
      this.append({ type: "draft_conflict", conversationId, revision: current.revision, }, { kind: "draft_conflict", conflict });
      throw Object.assign(new Error("draft revision conflict"), { code: "DRAFT_CONFLICT", current, displaced });
    }
    const draft: ConversationDraftDto = { conversationId, ownerId, text: input.text, attachmentIds, mentionBindings, revision: current.revision + 1, updatedAt: new Date().toISOString(), clientId: input.clientId };
    this.append({ type: "draft_changed", conversationId, revision: draft.revision, cleared: !draft.text && draft.attachmentIds.length === 0 }, { kind: "draft", draft });
    return draft;
  }

  listDraftConflicts(conversationId: string, ownerId = "legacy"): ConversationDraftConflictListDto {
    return { conversationId, conflicts: [...(this.draftConflicts.get(this.draftKey(conversationId, ownerId)) ?? [])] };
  }

  deleteDraft(draftId: string): void {
    const prefix = `${draftId}\u0000`;
    const current = [...this.drafts.entries()].find(([key]) => key.startsWith(prefix))?.[1];
    if (!current) return;
    this.append({ type: "draft_changed", conversationId: draftId, revision: current.revision + 1, cleared: true }, { kind: "draft_deleted", draftId });
  }

  createNotification(input: Omit<WorkspaceNotificationDto, "id" | "createdAt">, queueWebPush = false): WorkspaceNotificationDto {
    // Operational notifications may point at the same Communication while
    // representing different retry attempts. Their explicit dedupe key is the
    // identity; communicationEventId remains navigation metadata. Ordinary
    // communication notifications have no dedupe key and retain event identity.
    if (!input.dedupeKey && input.communicationEventId) {
      const existing = [...this.notifications.values()].find((item) => item.communicationEventId === input.communicationEventId);
      if (existing) return existing;
    }
    if (input.dedupeKey) {
      const existing = this.notificationsByDedupeKey.get(input.dedupeKey);
      if (existing) {
        if ((existing.status ?? "open") !== "open") return existing;
        const updated: WorkspaceNotificationDto = {
          ...existing,
          ...input,
          id: existing.id,
          createdAt: existing.createdAt,
          ...(existing.readAt ? { readAt: existing.readAt } : {}),
        };
        if (JSON.stringify(updated) === JSON.stringify(existing)) return existing;
        this.append(
          {
            type: "notification_changed",
            notificationId: existing.id,
            conversationId: updated.conversationId,
            action: "updated",
          },
          { kind: "notification", notification: updated },
        );
        return updated;
      }
    }
    const notification = {
      category: input.kind === "operational" ? "system" as const : "communication" as const,
      severity: "info" as const,
      status: "open" as const,
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const pushTargets = queueWebPush
      ? [...this.pushSubscriptions.values()].map(({ deviceId, updatedAt }) => ({ deviceId, subscriptionUpdatedAt: updatedAt }))
      : undefined;
    this.append(
      { type: "notification_changed", notificationId: notification.id, conversationId: notification.conversationId, action: "created" },
      { kind: "notification", notification, ...(pushTargets?.length ? { pushTargets } : {}) },
    );
    return this.notifications.get(notification.id)!;
  }

  /** Iterate operator notifications without materializing the complete
   * historical collection. Collaboration remains agent-only, and dismissed
   * rows remain outside every operator notification surface. */
  forEachNotification(visitor: (item: WorkspaceNotificationDto) => void): void {
    for (const item of this.notifications.values()) {
      if (item.kind === "collaboration" || (item.status ?? "open") === "dismissed") continue;
      visitor(item);
    }
  }

  findNotification(
    predicate: (item: WorkspaceNotificationDto) => boolean,
  ): WorkspaceNotificationDto | undefined {
    for (const item of this.notifications.values()) {
      if (item.kind === "collaboration" || (item.status ?? "open") === "dismissed") continue;
      if (predicate(item)) return item;
    }
    return undefined;
  }

  openOperationalNotification(dedupeKey: string): WorkspaceNotificationDto | undefined {
    return this.openOperationalNotificationsByDedupeKey.get(dedupeKey);
  }

  forEachOpenOperationalNotification(
    dedupeKeyPrefix: string,
    visitor: (item: WorkspaceNotificationDto) => void,
  ): void {
    for (const [dedupeKey, item] of this.openOperationalNotificationsByDedupeKey) {
      if (dedupeKey.startsWith(dedupeKeyPrefix)) visitor(item);
    }
  }

  /** Return a keyset-paginated live feed. The scan also produces exact badge
   * counts, while retaining at most one bounded page in memory. */
  listNotificationPage(input: {
    limit: number;
    before?: WorkspaceNotificationPageCursor;
  }): WorkspaceNotificationPage {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    let start = 0;
    if (input.before) {
      let low = 0;
      let high = this.activeNotifications.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareNotificationsNewestFirst(this.activeNotifications[middle]!, input.before) <= 0) low = middle + 1;
        else high = middle;
      }
      start = low;
    }
    const items = this.activeNotifications.slice(start, start + limit);
    const last = items.at(-1);
    return {
      items,
      openActionCount: this.notificationOpenActionCount,
      unacknowledgedActionCount: this.notificationUnacknowledgedActionCount,
      unreadUpdateCount: this.notificationUnreadUpdateCount,
      ...(last && start + items.length < this.activeNotifications.length
        ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
        : {}),
    };
  }

  activeNotificationIds(notificationIds: readonly string[]): string[] {
    return notificationIds.filter((id) => {
      const notification = this.notifications.get(id);
      return notification ? Boolean(notificationLiveKind(notification)) : false;
    });
  }

  notificationSearchState(input: {
    communicationEventIds: readonly string[];
    conversationIds: readonly string[];
  }): {
    unreadCommunicationEventIds: string[];
    unreadConversationCounts: Record<string, number>;
  } {
    const unreadCommunicationEventIds = [...new Set(input.communicationEventIds)]
      .filter((id) => (this.unreadNotificationIdsByCommunication.get(id)?.size ?? 0) > 0);
    const unreadConversationCounts: Record<string, number> = {};
    for (const id of new Set(input.conversationIds)) {
      const count = this.unreadNotificationIdsByConversation.get(id)?.size ?? 0;
      if (count > 0) unreadConversationCounts[id] = count;
    }
    return { unreadCommunicationEventIds, unreadConversationCounts };
  }

  /** Produce exact, identity-deduped unread projections without exposing the
   * underlying notification collection. The caller bounds which resource
   * scopes are returned; workspace and All Messages remain scalar summaries. */
  notificationProjection(input: {
    projectIds: readonly string[];
    conversationIds: readonly string[];
  }): WorkspaceNotificationProjectionDto {
    const requestedProjectIds = new Set(input.projectIds);
    const requestedConversationIds = new Set(input.conversationIds);
    const workspace = emptyNotificationProjectionAccumulator();
    const allMessages = emptyNotificationProjectionAccumulator();
    const projects = new Map<string, {
      total: NotificationProjectionAccumulator;
      chat: NotificationProjectionAccumulator;
      projectLevel: NotificationProjectionAccumulator;
      affectedConversationIds: Set<string>;
    }>();
    const conversations = new Map<string, NotificationProjectionAccumulator>();

    for (const projectId of requestedProjectIds) {
      projects.set(projectId, {
        total: emptyNotificationProjectionAccumulator(),
        chat: emptyNotificationProjectionAccumulator(),
        projectLevel: emptyNotificationProjectionAccumulator(),
        affectedConversationIds: new Set<string>(),
      });
    }
    for (const conversationId of requestedConversationIds) {
      conversations.set(conversationId, emptyNotificationProjectionAccumulator());
    }

    for (const item of this.notifications.values()) {
      const kind = unreadProjectionKind(item);
      if (!kind) continue;
      const navigationConversationIds = new Set([
        ...(item.conversationId ? [item.conversationId] : []),
        ...(item.conversationIds ?? []),
      ]);
      // Communication notifications are Chat-scoped. An action is Chat-scoped
      // only when it names one canonical conversation; conversationIds on
      // operational notifications are navigation destinations, not ownership.
      const conversationIds = MESSAGE_NOTIFICATION_KINDS.has(item.kind)
        ? navigationConversationIds
        : new Set(item.conversationId ? [item.conversationId] : []);
      addNotificationProjection(workspace, item, kind);
      if (MESSAGE_NOTIFICATION_KINDS.has(item.kind) && conversationIds.size > 0) {
        addNotificationProjection(allMessages, item, kind);
      }

      if (item.projectId) {
        const project = projects.get(item.projectId);
        if (project) {
          addNotificationProjection(project.total, item, kind);
          const scope = conversationIds.size > 0 ? project.chat : project.projectLevel;
          addNotificationProjection(scope, item, kind);
          if (conversationIds.size > 0) {
            for (const conversationId of conversationIds) {
              project.affectedConversationIds.add(conversationId);
            }
          }
        }
      }

      for (const conversationId of conversationIds) {
        const conversation = conversations.get(conversationId);
        if (conversation) addNotificationProjection(conversation, item, kind);
      }
    }

    return {
      workspace: notificationProjectionCounts(workspace),
      allMessages: notificationProjectionCounts(allMessages),
      projects: Object.fromEntries([...projects].map(([projectId, project]) => {
        const projected: WorkspaceProjectNotificationProjectionDto = {
          ...notificationProjectionCounts(project.total),
          chat: {
            ...notificationProjectionCounts(project.chat),
            affectedConversationCount: project.affectedConversationIds.size,
          },
          projectLevel: notificationProjectionCounts(project.projectLevel),
        };
        return [projectId, projected];
      })),
      conversations: Object.fromEntries([...conversations].map(([conversationId, projection]) => [
        conversationId,
        notificationProjectionCounts(projection),
      ])),
    };
  }

  /** Resolve unread informational notifications by canonical Communication
   * identity, including notifications older than the bounded live-feed page. */
  readNotificationsForCommunicationEvents(communicationEventIds: readonly string[]): number {
    const notificationIds = new Set<string>();
    for (const communicationEventId of new Set(communicationEventIds)) {
      for (const notificationId of this.unreadNotificationIdsByCommunication.get(communicationEventId) ?? []) {
        notificationIds.add(notificationId);
      }
    }
    if (!notificationIds.size) return 0;
    const readAt = new Date().toISOString();
    this.append(
      { type: "notification_changed", action: "read" },
      { kind: "notifications_read_ids", notificationIds: [...notificationIds], readAt },
    );
    return notificationIds.size;
  }

  readNotification(notificationId: string): boolean {
    const current = this.notifications.get(notificationId);
    if (!current) return false;
    if (isOpenAttentionNotification(current)) return false;
    if (current.readAt) return true;
    const readAt = new Date().toISOString();
    this.append(
      { type: "notification_changed", notificationId, conversationId: current.conversationId, action: "read" },
      { kind: "notifications_read_ids", notificationIds: [notificationId], readAt },
    );
    return true;
  }

  acknowledgeNotifications(notificationIds: readonly string[]): number {
    const ids = [...new Set(notificationIds)].filter((notificationId) => {
      const current = this.notifications.get(notificationId);
      return Boolean(current && isOpenAttentionNotification(current) && !current.acknowledgedAt);
    });
    if (!ids.length) return 0;
    const acknowledgedAt = new Date().toISOString();
    this.append(
      { type: "notification_changed", action: "acknowledged" },
      { kind: "notifications_acknowledged_ids", notificationIds: ids, acknowledgedAt },
    );
    return ids.length;
  }

  putPushSubscription(input: Omit<WebPushSubscriptionDto, "updatedAt">): WebPushSubscriptionDto {
    const existing = this.pushSubscriptions.get(input.deviceId);
    if (existing && existing.endpoint === input.endpoint && existing.expirationTime === input.expirationTime &&
      existing.keys.p256dh === input.keys.p256dh && existing.keys.auth === input.keys.auth) return existing;
    const subscription = { ...input, updatedAt: new Date().toISOString() };
    // A browser subscription endpoint identifies one physical subscription. If
    // local storage was cleared, replace its stale device ID instead of sending
    // every notification twice to the same endpoint.
    const replacedDeviceIds = [...this.pushSubscriptions.values()]
      .filter((candidate) => candidate.deviceId !== input.deviceId && candidate.endpoint === input.endpoint)
      .map((candidate) => candidate.deviceId);
    this.append(
      { type: "push_subscription_changed", deviceId: input.deviceId, action: "upserted" },
      { kind: "push_subscription", deviceId: input.deviceId, subscription, ...(replacedDeviceIds.length ? { replacedDeviceIds } : {}) },
    );
    return subscription;
  }

  deletePushSubscription(deviceId: string): void {
    if (!this.pushSubscriptions.has(deviceId)) return;
    this.append({ type: "push_subscription_changed", deviceId, action: "deleted" }, { kind: "push_subscription", deviceId });
  }

  listPushSubscriptions(): WebPushSubscriptionDto[] { return [...this.pushSubscriptions.values()]; }

  hasPushSubscription(deviceId: string): boolean { return this.pushSubscriptions.has(deviceId); }

  getNotification(notificationId: string): WorkspaceNotificationDto | undefined {
    return this.notifications.get(notificationId);
  }

  setNotificationStatus(notificationId: string, status: "resolved" | "dismissed"): WorkspaceNotificationDto | undefined {
    const current = this.notifications.get(notificationId);
    if (!current || (current.status ?? "open") !== "open") return current;
    const at = new Date().toISOString();
    this.append(
      { type: "notification_changed", notificationId, conversationId: current.conversationId, action: "resolved" },
      { kind: "notification_status", notificationId, status, at },
    );
    return this.notifications.get(notificationId);
  }

  createDecision(input: Omit<DecisionDto, "id" | "status" | "createdAt" | "updatedAt"> & { idempotencyKey: string }): DecisionDto {
    const key = `${input.agentId}\u0000${input.idempotencyKey}`;
    const existingId = this.decisionIdempotency.get(key);
    if (existingId) return this.decisions.get(existingId)!;
    const now = new Date().toISOString();
    const decision: DecisionDto = {
      ...input,
      id: randomUUID(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const { idempotencyKey: _idempotencyKey, ...stored } = decision as DecisionDto & { idempotencyKey?: string };
    this.append(
      { type: "notification_changed", action: "created", conversationId: decision.conversationId },
      { kind: "decision", decision: stored, idempotencyKey: key },
    );
    return stored;
  }

  listDecisions(filter: { projectId?: string; conversationId?: string; agentId?: string; status?: DecisionDto["status"] } = {}): DecisionDto[] {
    return [...this.decisions.values()].filter((decision) =>
      (!filter.projectId || decision.projectId === filter.projectId) &&
      (!filter.conversationId || decision.conversationId === filter.conversationId) &&
      (!filter.agentId || decision.agentId === filter.agentId) &&
      (!filter.status || decision.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listDecisionPage(input: {
    projectId: string;
    conversationId?: string;
    agentId?: string;
    limit: number;
    before?: { createdAt: string; id: string };
  }): { decisions: DecisionDto[]; hasMore: boolean } {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const ids = input.conversationId && input.agentId
      ? this.decisionIdsByConversationAgent.get(`${input.conversationId}\u0000${input.agentId}`) ?? []
      : input.agentId
        ? this.decisionIdsByAgent.get(input.agentId) ?? []
        : input.conversationId
          ? this.decisionIdsByConversation.get(input.conversationId) ?? []
          : this.decisionIdsByProject.get(input.projectId) ?? [];
    const selected: DecisionDto[] = [];
    let hasMore = false;
    for (const id of ids) {
      const decision = this.decisions.get(id);
      if (!decision || decision.projectId !== input.projectId ||
          (input.conversationId && decision.conversationId !== input.conversationId) ||
          (input.agentId && decision.agentId !== input.agentId) ||
          (input.before && !(decision.createdAt < input.before.createdAt ||
            (decision.createdAt === input.before.createdAt && decision.id < input.before.id)))) continue;
      if (selected.length === limit) { hasMore = true; break; }
      selected.push(decision);
    }
    return { decisions: selected, hasMore };
  }

  listDecisionEventPage(input: {
    projectId?: string;
    conversationId?: string;
    limit: number;
    before?: { createdAt: string; id: string };
  }): { events: DecisionEventProjection[]; hasMore: boolean } {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const ids = input.conversationId
      ? this.decisionEventIdsByConversation.get(input.conversationId) ?? []
      : input.projectId
        ? this.decisionEventIdsByProject.get(input.projectId) ?? []
        : this.decisionEventIds;
    let start = 0;
    if (input.before) {
      let low = 0;
      let high = ids.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const event = this.decisionEventForId(ids[middle]!);
        const isOlder = Boolean(event && (
          event.createdAt < input.before.createdAt ||
          (event.createdAt === input.before.createdAt && event.id < input.before.id)
        ));
        if (isOlder) high = middle;
        else low = middle + 1;
      }
      start = low;
    }
    const selected: DecisionEventProjection[] = [];
    let hasMore = false;
    for (let index = start; index < ids.length; index += 1) {
      const event = this.decisionEventForId(ids[index]!);
      if (!event ||
          (input.projectId && event.decision.projectId !== input.projectId) ||
          (input.conversationId && event.decision.conversationId !== input.conversationId)) continue;
      if (selected.length === limit) {
        hasMore = true;
        break;
      }
      selected.push(event);
    }
    return { events: selected, hasMore };
  }

  decisionsForRuns(runIds: ReadonlySet<string>): DecisionDto[] {
    const ids = new Set<string>();
    for (const runId of runIds) for (const decisionId of this.decisionIdsByRun.get(runId) ?? []) ids.add(decisionId);
    return [...ids].flatMap((id) => {
      const decision = this.decisions.get(id);
      return decision ? [decision] : [];
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  }

  getDecision(id: string): DecisionDto | undefined { return this.decisions.get(id); }

  resolveDecision(id: string, response: NonNullable<DecisionDto["response"]>): DecisionDto | undefined {
    const current = this.decisions.get(id);
    if (!current || current.status !== "pending") return current;
    const next: DecisionDto = { ...current, status: "resolved", response, updatedAt: response.respondedAt };
    const key = [...this.decisionIdempotency.entries()].find(([, decisionId]) => decisionId === id)?.[0] ?? `decision:${id}`;
    this.append(
      { type: "notification_changed", action: "resolved", conversationId: current.conversationId },
      { kind: "decision", decision: next, idempotencyKey: key },
    );
    return next;
  }

  cancelDecision(id: string, at = new Date().toISOString()): DecisionDto | undefined {
    const current = this.decisions.get(id);
    if (!current || current.status !== "pending") return current;
    const next: DecisionDto = { ...current, status: "cancelled", updatedAt: at };
    const key = [...this.decisionIdempotency.entries()].find(([, decisionId]) => decisionId === id)?.[0] ?? `decision:${id}`;
    this.append(
      { type: "notification_changed", action: "resolved", conversationId: current.conversationId },
      { kind: "decision", decision: next, idempotencyKey: key },
    );
    return next;
  }

  cancelDecisionsForAgent(agentId: string, at = new Date().toISOString()): DecisionDto[] {
    const cancelled: DecisionDto[] = [];
    for (const current of this.listDecisions({ agentId, status: "pending" })) {
      const next = this.cancelDecision(current.id, at);
      if (next) cancelled.push(next);
    }
    return cancelled;
  }

  duePushDeliveries(now = new Date()): Array<{ delivery: PushDeliveryRecord; notification: WorkspaceNotificationDto; subscription: WebPushSubscriptionDto }> {
    const due = now.toISOString();
    const result: Array<{ delivery: PushDeliveryRecord; notification: WorkspaceNotificationDto; subscription: WebPushSubscriptionDto }> = [];
    for (const delivery of this.pushDeliveries.values()) {
      if (delivery.status !== "pending" || delivery.nextAttemptAt > due) continue;
      const notification = this.notifications.get(delivery.notificationId);
      const subscription = this.pushSubscriptions.get(delivery.deviceId);
      // A replaced/rotated subscription must not receive work queued for the
      // old endpoint. Its new subscription begins with the next notification.
      if (!notification || !subscription || subscription.updatedAt !== delivery.subscriptionUpdatedAt) continue;
      result.push({ delivery, notification, subscription });
    }
    return result;
  }

  updatePushDelivery(input: {
    notificationId: string;
    deviceId: string;
    status: PushDeliveryRecord["status"];
    nextAttemptAt?: string;
    deliveredAt?: string;
    lastError?: string;
  }): PushDeliveryRecord | undefined {
    const key = this.pushDeliveryKey(input.notificationId, input.deviceId);
    const current = this.pushDeliveries.get(key);
    if (!current || current.status !== "pending") return current;
    const delivery: PushDeliveryRecord = {
      ...current,
      status: input.status,
      attempts: current.attempts + 1,
      nextAttemptAt: input.nextAttemptAt ?? current.nextAttemptAt,
      ...(input.deliveredAt ? { deliveredAt: input.deliveredAt } : {}),
      ...(input.lastError ? { lastError: input.lastError.slice(0, 160) } : {}),
    };
    const action = input.status === "delivered" ? "delivered" : input.status === "abandoned" ? "abandoned" : "retry_scheduled";
    this.append(
      { type: "push_delivery_changed", notificationId: input.notificationId, deviceId: input.deviceId, action },
      { kind: "push_delivery", delivery },
    );
    return delivery;
  }

  listPushDeliveries(): PushDeliveryRecord[] { return [...this.pushDeliveries.values()]; }

  nextPushDeliveryAt(): string | undefined {
    return [...this.pushDeliveries.values()]
      .filter((delivery) => {
        if (delivery.status !== "pending") return false;
        const subscription = this.pushSubscriptions.get(delivery.deviceId);
        return subscription?.updatedAt === delivery.subscriptionUpdatedAt && this.notifications.has(delivery.notificationId);
      })
      .map((delivery) => delivery.nextAttemptAt)
      .sort()[0];
  }

  private pushDeliveryKey(notificationId: string, deviceId: string): string {
    return `${notificationId}\u0000${deviceId}`;
  }
}

function normalizeNotifications(input: unknown): NotificationPreferencesDto {
  if (input && typeof input === "object") {
    const value = input as Partial<NotificationPreferencesDto>;
    return {
      directResponses: value.directResponses ?? true,
      broadcasts: value.broadcasts ?? true,
    };
  }
  return { directResponses: true, broadcasts: true };
}

function clampContextRolloverTokens(value: number): number {
  return Math.max(75_000, Math.min(2_000_000, Math.round(value)));
}

function clampContextRolloverWindowFraction(value: number): number {
  return Math.max(0.3, Math.min(0.95, value));
}

function normalizeClaudeModelOptions(
  input: unknown,
): WorkspacePreferencesDto["claudeModelOptions"] {
  if (!Array.isArray(input)) return [];
  const models = new Map<string, WorkspacePreferencesDto["claudeModelOptions"][number]>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as {
      id?: unknown;
      label?: unknown;
      resolvedModel?: unknown;
      validatedAt?: unknown;
      availability?: unknown;
      unavailableReason?: unknown;
    };
    const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 200) : "";
    if (!id) continue;
    const label = typeof raw.label === "string"
      ? raw.label.trim().slice(0, 200)
      : "";
    const resolvedModel = typeof raw.resolvedModel === "string"
      ? raw.resolvedModel.trim().slice(0, 200)
      : "";
    const validatedAt = typeof raw.validatedAt === "string" && Number.isFinite(Date.parse(raw.validatedAt))
      ? new Date(raw.validatedAt).toISOString()
      : undefined;
    const availability = raw.availability === "available" || raw.availability === "unavailable"
      ? raw.availability
      : undefined;
    const unavailableReason = typeof raw.unavailableReason === "string"
      ? raw.unavailableReason.trim().slice(0, 1_000)
      : "";
    models.set(id, {
      id,
      ...(label ? { label } : {}),
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(validatedAt ? { validatedAt } : {}),
      ...(availability ? { availability } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
    });
    if (models.size >= 100) break;
  }
  return [...models.values()];
}

function normalizeProfile(input: unknown): WorkspacePreferencesDto["profile"] {
  const value = input && typeof input === "object" ? input as Partial<WorkspacePreferencesDto["profile"]> : {};
  const displayName = typeof value.displayName === "string" && value.displayName.trim() ? value.displayName.trim().slice(0, 80) : "User";
  const rawHandle = typeof value.handle === "string" ? value.handle.trim().replace(/^#/, "").toLowerCase() : "operator";
  const handle = /^[a-z][a-z0-9_-]{1,31}$/.test(rawHandle) && !["broadcast", "everyone", "user"].includes(rawHandle) ? rawHandle : "operator";
  const avatarId = typeof value.avatarId === "string" && (
    /^[a-z0-9_-]{1,64}$/i.test(value.avatarId) || /^uploaded:(?:png|jpeg|webp|gif|avif):[a-f0-9]{64}$/u.test(value.avatarId)
  ) ? value.avatarId : "default-user";
  return { displayName, handle, avatarId };
}
