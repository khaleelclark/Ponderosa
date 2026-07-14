import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ConversationDraftDto,
  NotificationPreference,
  UpdateWorkspacePreferencesRequest,
  WorkspaceEvent,
  WorkspaceEventEnvelope,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
  WebPushSubscriptionDto,
} from "@ponderosa/core";
import { appendFsyncedJsonl, readRepairableJsonl } from "./append-jsonl.js";
import { workspaceEventsPath } from "./paths.js";

type CanonicalWorkspaceEvent = WorkspaceEventEnvelope & {
  mutation?:
    | { kind: "draft"; draft: ConversationDraftDto }
    | { kind: "notification"; notification: WorkspaceNotificationDto }
    | { kind: "notifications_read"; conversationId: string; readAt: string }
    | { kind: "push_subscription"; subscription?: WebPushSubscriptionDto; deviceId: string };
};

const DEFAULT_PREFERENCES: WorkspacePreferencesDto = {
  projectSort: "last_used",
  sidebarCollapsed: false,
  sidebarWidth: 288,
  notifications: "all_messages",
  fontFamily: "inter",
  updatedAt: new Date(0).toISOString(),
};

/** Canonical workspace/user event log with rebuildable in-memory projections. */
export class WorkspaceStore {
  private readonly file: string;
  private readonly events: CanonicalWorkspaceEvent[];
  private readonly drafts = new Map<string, ConversationDraftDto>();
  private readonly notifications = new Map<string, WorkspaceNotificationDto>();
  private readonly pushSubscriptions = new Map<string, WebPushSubscriptionDto>();
  private preferences = DEFAULT_PREFERENCES;

  constructor(dataDir: string) {
    this.file = workspaceEventsPath(dataDir);
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    chmodSync(this.file, 0o600);
    this.events = readRepairableJsonl<CanonicalWorkspaceEvent>(this.file, "workspace event log", true);
    for (const event of this.events) this.project(event);
  }

  private project(record: CanonicalWorkspaceEvent): void {
    if (record.event.type === "preferences_updated") this.preferences = record.event.preferences;
    if (record.mutation?.kind === "draft") this.drafts.set(record.mutation.draft.conversationId, record.mutation.draft);
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

  getPreferences(): WorkspacePreferencesDto { return this.preferences; }

  updatePreferences(patch: UpdateWorkspacePreferencesRequest): WorkspacePreferencesDto {
    const notifications: NotificationPreference = patch.notifications ?? this.preferences.notifications;
    const preferences: WorkspacePreferencesDto = {
      ...this.preferences,
      ...patch,
      notifications,
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

  createNotification(input: Omit<WorkspaceNotificationDto, "id" | "createdAt">): WorkspaceNotificationDto {
    if (input.communicationEventId) {
      const existing = [...this.notifications.values()].find((item) => item.communicationEventId === input.communicationEventId);
      if (existing) return existing;
    }
    const notification = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.append({ type: "notification_changed", notificationId: notification.id, conversationId: notification.conversationId, action: "created" }, { kind: "notification", notification });
    return notification;
  }

  listNotifications(): WorkspaceNotificationDto[] { return [...this.notifications.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

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
