import type { WorkspaceNotificationDto } from "@ponderosa/core";
import type { PushDeliveryRecord, WorkspaceStore } from "@ponderosa/agents";

export interface PushSendError extends Error {
  statusCode?: number;
}

export interface WebPushSender {
  send(subscription: { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }, payload: string, options: { TTL: number; urgency: "normal"; topic: string; timeout: number }): Promise<void>;
}

export interface WebPushDeliveryOptions {
  store: WorkspaceStore;
  sender: WebPushSender;
  onWorkspaceEvents(cursor: number): void;
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 60_000, 5 * 60_000] as const;
const DEFAULT_WEB_PUSH_SEND_TIMEOUT_MS = 4_000;

/**
 * Drains canonical per-device delivery records. Web Push acknowledgements are
 * persisted before a delivery leaves the retry set, and the service worker also
 * deduplicates notification IDs to cover an ambiguous network acknowledgement.
 */
export class WebPushDeliveryManager {
  private readonly inFlight = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private drainPromise?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: WebPushDeliveryOptions) {}

  start(): void {
    this.stopped = false;
    void this.drain();
  }

  notify(): void {
    if (!this.stopped) void this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.drainPromise;
  }

  async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.drainPromise) return this.drainPromise;
    const running = this.drainOnce();
    this.drainPromise = running;
    try {
      await running;
    } finally {
      if (this.drainPromise === running) this.drainPromise = undefined;
    }
  }

  private async drainOnce(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const due = this.options.store.duePushDeliveries(new Date());
    await Promise.allSettled(due.map(async ({ delivery, notification, subscription }) => {
      const key = `${delivery.notificationId}\u0000${delivery.deviceId}`;
      if (this.inFlight.has(key)) return;
      this.inFlight.add(key);
      try {
        await this.options.sender.send(subscription, JSON.stringify(pushPayload(notification)), {
          TTL: 60 * 60,
          urgency: "normal",
          topic: pushTopic(notification.id),
          timeout: DEFAULT_WEB_PUSH_SEND_TIMEOUT_MS,
        });
        const cursor = this.options.store.cursor();
        this.options.store.updatePushDelivery({
          notificationId: delivery.notificationId,
          deviceId: delivery.deviceId,
          status: "delivered",
          deliveredAt: new Date().toISOString(),
        });
        this.options.onWorkspaceEvents(cursor);
      } catch (error) {
        this.recordFailure(delivery, error as PushSendError);
      } finally {
        this.inFlight.delete(key);
      }
    }));
    this.scheduleNext();
  }

  private recordFailure(delivery: PushDeliveryRecord, error: PushSendError): void {
    const statusCode = error.statusCode;
    const expired = statusCode === 404 || statusCode === 410;
    const nextDelay = DEFAULT_RETRY_DELAYS_MS[delivery.attempts];
    const cursor = this.options.store.cursor();
    if (expired) this.options.store.deletePushSubscription(delivery.deviceId);
    this.options.store.updatePushDelivery({
      notificationId: delivery.notificationId,
      deviceId: delivery.deviceId,
      status: expired || nextDelay === undefined ? "abandoned" : "pending",
      ...(nextDelay === undefined ? {} : { nextAttemptAt: new Date(Date.now() + nextDelay).toISOString() }),
      lastError: statusCode ? `push service returned ${statusCode}` : "push delivery failed",
    });
    this.options.onWorkspaceEvents(cursor);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const nextAt = this.options.store.nextPushDeliveryAt();
    if (!nextAt) return;
    const next = Date.parse(nextAt);
    if (!Number.isFinite(next)) return;
    const delay = Math.max(50, next - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delay);
    this.timer.unref?.();
  }
}

export function pushPayload(notification: WorkspaceNotificationDto): Record<string, unknown> {
  const message = notification.communicationEventId
    ? `?message=${encodeURIComponent(notification.communicationEventId)}`
    : "";
  return {
    notificationId: notification.id,
    title: notification.title,
    body: notification.body,
    projectId: notification.projectId,
    conversationId: notification.conversationId,
    url: notification.projectId && notification.conversationId
      ? `/projects/${encodeURIComponent(notification.projectId)}/chats/${encodeURIComponent(notification.conversationId)}${message}`
      : notification.projectId ? `/projects/${encodeURIComponent(notification.projectId)}` : "/",
  };
}

function pushTopic(notificationId: string): string {
  return notificationId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "ponderosa";
}
