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
  WorkspaceNotificationDto,
  NotificationPreferencesDto,
  WorkspacePreferencesDto,
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
    | { kind: "notifications_read_all"; readAt: string }
    | { kind: "notifications_cleared"; notificationIds: string[] }
    | { kind: "notification_status"; notificationId: string; status: "resolved" | "dismissed"; at: string }
    | { kind: "decision"; decision: DecisionDto; idempotencyKey: string }
    | { kind: "push_subscription"; subscription?: WebPushSubscriptionDto; deviceId: string; replacedDeviceIds?: string[] }
    | { kind: "push_delivery"; delivery: PushDeliveryRecord };
};

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
  sidebarCollapsed: false,
  sidebarWidth: 288,
  notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false },
  fontFamily: "inter",
  providerAvailability: {},
  globalInstructions: "",
  profile: { displayName: "User", handle: "operator", avatarId: "default-user" },
  updatedAt: new Date(0).toISOString(),
};

/** Canonical workspace/user event log with rebuildable in-memory projections. */
export class WorkspaceStore {
  private readonly file: string;
  private readonly instance: string;
  private readonly events: CanonicalWorkspaceEvent[];
  private readonly drafts = new Map<string, ConversationDraftDto>();
  private readonly draftConflicts = new Map<string, ConversationDraftConflictDto[]>();
  private readonly notifications = new Map<string, WorkspaceNotificationDto>();
  private readonly decisions = new Map<string, DecisionDto>();
  private readonly decisionIdempotency = new Map<string, string>();
  private readonly pushSubscriptions = new Map<string, WebPushSubscriptionDto>();
  private readonly pushDeliveries = new Map<string, PushDeliveryRecord>();
  private preferences = DEFAULT_PREFERENCES;

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

  private project(record: CanonicalWorkspaceEvent): void {
    if (record.event.type === "preferences_updated") this.preferences = {
      ...DEFAULT_PREFERENCES,
      ...record.event.preferences,
      notifications: normalizeNotifications(record.event.preferences.notifications),
      projectOrder: record.event.preferences.projectOrder ?? [],
      providerAvailability: record.event.preferences.providerAvailability ?? {},
      globalInstructions: record.event.preferences.globalInstructions ?? "",
      profile: normalizeProfile(record.event.preferences.profile),
    };
    if (record.mutation?.kind === "draft") this.drafts.set(record.mutation.draft.conversationId, record.mutation.draft);
    if (record.mutation?.kind === "draft_conflict") {
      const conversationId = record.mutation.conflict.current.conversationId;
      const conflicts = this.draftConflicts.get(conversationId) ?? [];
      conflicts.push(record.mutation.conflict);
      // Keep the canonical log complete, but bound the projection used by the UI.
      this.draftConflicts.set(conversationId, conflicts.slice(-20));
    }
    if (record.mutation?.kind === "draft_deleted") this.drafts.delete(record.mutation.draftId);
    if (record.mutation?.kind === "notification") {
      this.notifications.set(record.mutation.notification.id, record.mutation.notification);
      for (const target of record.mutation.pushTargets ?? []) {
        const key = this.pushDeliveryKey(record.mutation.notification.id, target.deviceId);
        if (!this.pushDeliveries.has(key)) this.pushDeliveries.set(key, {
          notificationId: record.mutation.notification.id,
          deviceId: target.deviceId,
          subscriptionUpdatedAt: target.subscriptionUpdatedAt,
          status: "pending",
          attempts: 0,
          nextAttemptAt: record.ts,
        });
      }
    }
    if (record.mutation?.kind === "notifications_read") {
      for (const [id, item] of this.notifications) {
        if (item.conversationId === record.mutation.conversationId && !item.readAt) {
          this.notifications.set(id, { ...item, readAt: record.mutation.readAt });
        }
      }
    }
    if (record.mutation?.kind === "notifications_read_all") {
      for (const [id, item] of this.notifications) {
        if (!item.readAt) this.notifications.set(id, { ...item, readAt: record.mutation.readAt });
      }
    }
    if (record.mutation?.kind === "notifications_cleared") {
      for (const notificationId of record.mutation.notificationIds) {
        this.notifications.delete(notificationId);
        for (const key of this.pushDeliveries.keys()) {
          if (key.startsWith(`${notificationId}\u0000`)) this.pushDeliveries.delete(key);
        }
      }
    }
    if (record.mutation?.kind === "notification_status") {
      const current = this.notifications.get(record.mutation.notificationId);
      if (current) this.notifications.set(current.id, {
        ...current,
        status: record.mutation.status,
        resolvedAt: record.mutation.at,
        readAt: current.readAt ?? record.mutation.at,
      });
    }
    if (record.mutation?.kind === "decision") {
      this.decisions.set(record.mutation.decision.id, record.mutation.decision);
      this.decisionIdempotency.set(record.mutation.idempotencyKey, record.mutation.decision.id);
      for (const [id, notification] of this.notifications) {
        if (notification.decision?.id !== record.mutation.decision.id) continue;
        this.notifications.set(id, {
          ...notification,
          decision: { ...notification.decision, status: record.mutation.decision.status },
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

  readSince(id: number): WorkspaceEventEnvelope[] {
    return this.events.filter((item) => item.id > id).map(({ mutation: _mutation, ...event }) => event);
  }

  cursor(): number { return this.events.at(-1)?.id ?? 0; }

  instanceId(): string { return this.instance; }

  getPreferences(): WorkspacePreferencesDto { return this.preferences; }

  updatePreferences(patch: UpdateWorkspacePreferencesRequest): WorkspacePreferencesDto {
    const notifications = patch.notifications ? normalizeNotifications(patch.notifications) : this.preferences.notifications;
    const preferences: WorkspacePreferencesDto = {
      ...this.preferences,
      ...patch,
      notifications,
      projectOrder: patch.projectOrder ?? this.preferences.projectOrder,
      providerAvailability: patch.providerAvailability ?? this.preferences.providerAvailability,
      globalInstructions: (patch.globalInstructions ?? this.preferences.globalInstructions).slice(0, 100_000),
      profile: patch.profile ? normalizeProfile(patch.profile) : this.preferences.profile,
      sidebarWidth: Math.max(220, Math.min(520, Math.round(patch.sidebarWidth ?? this.preferences.sidebarWidth))),
      updatedAt: new Date().toISOString(),
    };
    this.append({ type: "preferences_updated", preferences });
    return preferences;
  }

  getDraft(conversationId: string): ConversationDraftDto {
    return this.drafts.get(conversationId) ?? { conversationId, text: "", attachmentIds: [], revision: 0, updatedAt: new Date(0).toISOString(), clientId: "" };
  }

  putDraft(conversationId: string, input: { text: string; attachmentIds: string[]; expectedRevision: number; clientId: string }): ConversationDraftDto {
    const current = this.getDraft(conversationId);
    if (current.revision !== input.expectedRevision) {
      const displaced: ConversationDraftConflictDto["displaced"] = {
        conversationId,
        text: input.text,
        attachmentIds: [...new Set(input.attachmentIds)],
        clientId: input.clientId,
        capturedAt: new Date().toISOString(),
      };
      const conflict: ConversationDraftConflictDto = { current, displaced };
      this.append({ type: "draft_conflict", conversationId, revision: current.revision, }, { kind: "draft_conflict", conflict });
      throw Object.assign(new Error("draft revision conflict"), { code: "DRAFT_CONFLICT", current, displaced });
    }
    const draft: ConversationDraftDto = { conversationId, text: input.text, attachmentIds: [...new Set(input.attachmentIds)], revision: current.revision + 1, updatedAt: new Date().toISOString(), clientId: input.clientId };
    this.append({ type: "draft_changed", conversationId, revision: draft.revision, cleared: !draft.text && draft.attachmentIds.length === 0 }, { kind: "draft", draft });
    return draft;
  }

  listDraftConflicts(conversationId: string): ConversationDraftConflictListDto {
    return { conversationId, conflicts: [...(this.draftConflicts.get(conversationId) ?? [])] };
  }

  deleteDraft(draftId: string): void {
    const current = this.drafts.get(draftId);
    if (!current) return;
    this.append({ type: "draft_changed", conversationId: draftId, revision: current.revision + 1, cleared: true }, { kind: "draft_deleted", draftId });
  }

  createNotification(input: Omit<WorkspaceNotificationDto, "id" | "createdAt">, queueWebPush = false): WorkspaceNotificationDto {
    if (input.communicationEventId) {
      const existing = [...this.notifications.values()].find((item) => item.communicationEventId === input.communicationEventId);
      if (existing) return existing;
    }
    if (input.dedupeKey) {
      const existing = [...this.notifications.values()].find((item) => item.dedupeKey === input.dedupeKey && (item.status ?? "open") === "open");
      if (existing) return existing;
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
    return notification;
  }

  listNotifications(): WorkspaceNotificationDto[] {
    // Collaboration/Team Chat is an agent-only room and is intentionally not
    // part of the operator notification or unread-count tree, including when
    // replaying logs created by an older server.
    return [...this.notifications.values()].filter((item) => item.kind !== "collaboration").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  readConversation(conversationId: string): void {
    const unread = this.listNotifications().some((item) => item.conversationId === conversationId && !item.readAt);
    if (!unread) return;
    const readAt = new Date().toISOString();
    this.append({ type: "notification_changed", conversationId, action: "read" }, { kind: "notifications_read", conversationId, readAt });
  }

  readAllNotifications(): number {
    const unread = this.listNotifications().filter((item) => !item.readAt);
    if (unread.length === 0) return 0;
    this.append(
      { type: "notification_changed", action: "read" },
      { kind: "notifications_read_all", readAt: new Date().toISOString() },
    );
    return unread.length;
  }

  clearNotifications(): number {
    const notificationIds = this.listNotifications().map((item) => item.id);
    if (notificationIds.length === 0) return 0;
    this.append(
      { type: "notification_changed", action: "cleared" },
      { kind: "notifications_cleared", notificationIds },
    );
    return notificationIds.length;
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
      { type: "notification_changed", notificationId, conversationId: current.conversationId, action: "read" },
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

  getDecision(id: string): DecisionDto | undefined { return this.decisions.get(id); }

  resolveDecision(id: string, response: NonNullable<DecisionDto["response"]>): DecisionDto | undefined {
    const current = this.decisions.get(id);
    if (!current || current.status !== "pending") return current;
    const next: DecisionDto = { ...current, status: "resolved", response, updatedAt: response.respondedAt };
    const key = [...this.decisionIdempotency.entries()].find(([, decisionId]) => decisionId === id)?.[0] ?? `decision:${id}`;
    this.append(
      { type: "notification_changed", action: "read", conversationId: current.conversationId },
      { kind: "decision", decision: next, idempotencyKey: key },
    );
    return next;
  }

  cancelDecisionsForAgent(agentId: string, at = new Date().toISOString()): DecisionDto[] {
    const cancelled: DecisionDto[] = [];
    for (const current of this.listDecisions({ agentId, status: "pending" })) {
      const next: DecisionDto = { ...current, status: "cancelled", updatedAt: at };
      const key = [...this.decisionIdempotency.entries()].find(([, decisionId]) => decisionId === current.id)?.[0] ?? `decision:${current.id}`;
      this.append(
        { type: "notification_changed", action: "read", conversationId: current.conversationId },
        { kind: "decision", decision: next, idempotencyKey: key },
      );
      cancelled.push(next);
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
      mentions: value.mentions !== false,
      directReplies: value.directReplies !== false,
      projectChatMessages: value.projectChatMessages !== false,
      broadcasts: value.broadcasts !== false,
      allMessages: value.allMessages === true,
    };
  }
  // Migrate the pre-toggle single-choice setting from the canonical log.
  const legacy = typeof input === "string" ? input : "all_messages";
  return {
    mentions: legacy === "mentions" || legacy === "all_messages" || legacy === "everyone" || legacy === "broadcasts",
    directReplies: legacy === "direct_responses" || legacy === "mentions" || legacy === "all_messages",
    projectChatMessages: legacy === "project_responses" || legacy === "all_messages",
    broadcasts: legacy === "broadcasts" || legacy === "all_messages",
    allMessages: legacy === "all_messages",
  };
}

function normalizeProfile(input: unknown): WorkspacePreferencesDto["profile"] {
  const value = input && typeof input === "object" ? input as Partial<WorkspacePreferencesDto["profile"]> : {};
  const displayName = typeof value.displayName === "string" && value.displayName.trim() ? value.displayName.trim().slice(0, 80) : "User";
  const rawHandle = typeof value.handle === "string" ? value.handle.trim().replace(/^#/, "").toLowerCase() : "operator";
  const handle = /^[a-z][a-z0-9_-]{1,31}$/.test(rawHandle) && !["broadcast", "everyone", "user"].includes(rawHandle) ? rawHandle : "operator";
  const avatarId = typeof value.avatarId === "string" && /^[a-z0-9_-]{1,64}$/i.test(value.avatarId) ? value.avatarId : "default-user";
  return { displayName, handle, avatarId };
}
