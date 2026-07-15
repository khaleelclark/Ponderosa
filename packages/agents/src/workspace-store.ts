import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ConversationDraftDto,
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
    | { kind: "draft_deleted"; draftId: string }
    | { kind: "notification"; notification: WorkspaceNotificationDto }
    | { kind: "notifications_read"; conversationId: string; readAt: string }
    | { kind: "push_subscription"; subscription?: WebPushSubscriptionDto; deviceId: string };
};

const DEFAULT_PREFERENCES: WorkspacePreferencesDto = {
  projectSort: "last_used",
  projectOrder: [],
  sidebarCollapsed: false,
  sidebarWidth: 288,
  notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false },
  fontFamily: "inter",
  updatedAt: new Date(0).toISOString(),
};

/** Canonical workspace/user event log with rebuildable in-memory projections. */
export class WorkspaceStore {
  private readonly file: string;
  private readonly instance: string;
  private readonly events: CanonicalWorkspaceEvent[];
  private readonly drafts = new Map<string, ConversationDraftDto>();
  private readonly notifications = new Map<string, WorkspaceNotificationDto>();
  private readonly pushSubscriptions = new Map<string, WebPushSubscriptionDto>();
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
    };
    if (record.mutation?.kind === "draft") this.drafts.set(record.mutation.draft.conversationId, record.mutation.draft);
    if (record.mutation?.kind === "draft_deleted") this.drafts.delete(record.mutation.draftId);
    if (record.mutation?.kind === "notification") this.notifications.set(record.mutation.notification.id, record.mutation.notification);
    if (record.mutation?.kind === "notifications_read") {
      for (const [id, item] of this.notifications) {
        if (item.conversationId === record.mutation.conversationId && !item.readAt) {
          this.notifications.set(id, { ...item, readAt: record.mutation.readAt });
        }
      }
    }
    if (record.mutation?.kind === "push_subscription") {
      if (record.mutation.subscription) this.pushSubscriptions.set(record.mutation.deviceId, record.mutation.subscription);
      else this.pushSubscriptions.delete(record.mutation.deviceId);
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
    if (current.revision !== input.expectedRevision) throw Object.assign(new Error("draft revision conflict"), { code: "DRAFT_CONFLICT", current });
    const draft: ConversationDraftDto = { conversationId, text: input.text, attachmentIds: [...new Set(input.attachmentIds)], revision: current.revision + 1, updatedAt: new Date().toISOString(), clientId: input.clientId };
    this.append({ type: "draft_changed", conversationId, revision: draft.revision, cleared: !draft.text && draft.attachmentIds.length === 0 }, { kind: "draft", draft });
    return draft;
  }

  deleteDraft(draftId: string): void {
    const current = this.drafts.get(draftId);
    if (!current) return;
    this.append({ type: "draft_changed", conversationId: draftId, revision: current.revision + 1, cleared: true }, { kind: "draft_deleted", draftId });
  }

  createNotification(input: Omit<WorkspaceNotificationDto, "id" | "createdAt">): WorkspaceNotificationDto {
    if (input.communicationEventId) {
      const existing = [...this.notifications.values()].find((item) => item.communicationEventId === input.communicationEventId);
      if (existing) return existing;
    }
    const notification = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.append({ type: "notification_changed", notificationId: notification.id, conversationId: notification.conversationId, action: "created" }, { kind: "notification", notification });
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

  putPushSubscription(input: Omit<WebPushSubscriptionDto, "updatedAt">): WebPushSubscriptionDto {
    const subscription = { ...input, updatedAt: new Date().toISOString() };
    this.append({ type: "push_subscription_changed", deviceId: input.deviceId, action: "upserted" }, { kind: "push_subscription", deviceId: input.deviceId, subscription });
    return subscription;
  }

  deletePushSubscription(deviceId: string): void {
    if (!this.pushSubscriptions.has(deviceId)) return;
    this.append({ type: "push_subscription_changed", deviceId, action: "deleted" }, { kind: "push_subscription", deviceId });
  }

  listPushSubscriptions(): WebPushSubscriptionDto[] { return [...this.pushSubscriptions.values()]; }
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
