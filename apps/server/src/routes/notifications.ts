import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type {
  WebPushSubscriptionDto,
  WorkspaceNotificationPageDto,
  WorkspaceNotificationProjectionRequestDto,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";

export interface NotificationRoutesOptions {
  readonly workspace: Pick<
    WorkspaceStore,
    | "activeNotificationIds"
    | "acknowledgeNotifications"
    | "cursor"
    | "dismissNotifications"
    | "getNotification"
    | "listNotificationPage"
    | "notificationProjection"
    | "readNotification"
    | "readNotificationsForCommunicationEvents"
    | "setNotificationStatus"
  >;
  readonly store: Pick<AgentStore, "getAgentTitleProjection">;
  readonly publishWorkspaceSince: (cursor: number) => void;
}

export interface PushRoutesOptions {
  readonly workspace: Pick<
    WorkspaceStore,
    "cursor" | "deletePushSubscription" | "hasPushSubscription" | "putPushSubscription"
  >;
  readonly publishWorkspaceSince: (cursor: number) => void;
  readonly configuration: {
    readonly configured: boolean;
    readonly state: "active" | "missing" | "invalid";
    readonly detail: string;
    readonly publicKey?: string;
  };
}

export function registerNotificationListRoute(
  app: FastifyInstance,
  options: NotificationRoutesOptions,
): void {
  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/api/notifications", async (request, reply) => {
    const requestedLimit = request.query.limit == null ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      return reply.code(400).send({ error: "limit must be an integer from 1 to 100" });
    }
    let before: { createdAt: string; id: string } | undefined;
    if (request.query.cursor) {
      try {
        if (request.query.cursor.length > 512) throw new Error("cursor is too long");
        const decoded = JSON.parse(Buffer.from(request.query.cursor, "base64url").toString("utf8")) as {
          createdAt?: unknown;
          id?: unknown;
        };
        if (typeof decoded.createdAt !== "string" || decoded.createdAt.length > 64 ||
          typeof decoded.id !== "string" || !decoded.id || decoded.id.length > 200) {
          throw new Error("cursor fields are invalid");
        }
        before = { createdAt: decoded.createdAt, id: decoded.id };
      } catch {
        return reply.code(400).send({ error: "cursor is invalid" });
      }
    }
    const page = options.workspace.listNotificationPage({
      limit: requestedLimit,
      ...(before ? { before } : {}),
    });
    const agentTitles = options.store.getAgentTitleProjection(
      page.items.flatMap((notification) => notification.agentId ? [notification.agentId] : []),
    );
    const items = page.items.map((notification) => {
      if (!notification.agentId) return notification;
      const agentTitle = agentTitles.get(notification.agentId);
      return {
        ...notification,
        ...(agentTitle ? { agentTitle } : {}),
      };
    });
    return {
      items,
      openActionCount: page.openActionCount,
      unacknowledgedActionCount: page.unacknowledgedActionCount,
      unreadUpdateCount: page.unreadUpdateCount,
      ...(page.nextCursor
        ? { nextCursor: Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url") }
        : {}),
    } satisfies WorkspaceNotificationPageDto;
  });

  app.post<{ Body: { notificationIds?: unknown } }>("/api/notifications/active", async (request, reply) => {
    const notificationIds = request.body?.notificationIds;
    if (!Array.isArray(notificationIds) || notificationIds.length > 100 ||
      notificationIds.some((id) => typeof id !== "string" || !id || id.length > 200)) {
      return reply.code(400).send({ error: "notificationIds must contain at most 100 notification IDs" });
    }
    return {
      activeNotificationIds: options.workspace.activeNotificationIds([...new Set(notificationIds)]),
    };
  });

  app.post<{ Body: Partial<WorkspaceNotificationProjectionRequestDto> }>(
    "/api/notifications/projection",
    async (request, reply) => {
      const projectIds = request.body?.projectIds;
      const conversationIds = request.body?.conversationIds;
      const validIds = (value: unknown): value is string[] => Array.isArray(value) &&
        value.length <= 200 &&
        value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200);
      if (!validIds(projectIds) || !validIds(conversationIds)) {
        return reply.code(400).send({
          error: "projectIds and conversationIds must each contain at most 200 IDs",
        });
      }
      return options.workspace.notificationProjection({
        projectIds: [...new Set(projectIds)],
        conversationIds: [...new Set(conversationIds)],
      });
    },
  );
}

export function registerNotificationMutationRoutes(
  app: FastifyInstance,
  options: NotificationRoutesOptions,
): void {
  app.post<{ Body: { kind?: "attention" | "updates" } }>(
    "/api/notifications/dismiss-all",
    async (request, reply) => {
      if (request.body?.kind !== "attention" && request.body?.kind !== "updates") {
        return reply.code(400).send({ error: "kind must be attention or updates" });
      }
      const cursor = options.workspace.cursor();
      const dismissed = options.workspace.dismissNotifications(request.body.kind);
      options.publishWorkspaceSince(cursor);
      return { dismissed };
    },
  );

  app.post<{ Params: { id: string }; Body: { status?: "resolved" | "dismissed" } }>(
    "/api/notifications/:id/status",
    async (request, reply) => {
      if (request.body?.status !== "resolved" && request.body?.status !== "dismissed") {
        return reply.code(400).send({ error: "status must be resolved or dismissed" });
      }
      const cursor = options.workspace.cursor();
      const notification = options.workspace.setNotificationStatus(request.params.id, request.body.status);
      if (!notification) return reply.code(404).send({ error: "notification not found" });
      options.publishWorkspaceSince(cursor);
      return notification;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/notifications/:id/read",
    async (request, reply) => {
      const cursor = options.workspace.cursor();
      const notification = options.workspace.readNotification(request.params.id);
      if (!notification) {
        return options.workspace.getNotification(request.params.id)
          ? reply.code(409).send({ error: "action notifications must be acknowledged, not marked read" })
          : reply.code(404).send({ error: "notification not found" });
      }
      options.publishWorkspaceSince(cursor);
      return { read: true };
    },
  );

  app.post<{ Body: { notificationIds?: unknown } }>(
    "/api/notifications/acknowledge-batch",
    async (request, reply) => {
      const notificationIds = request.body?.notificationIds;
      if (!Array.isArray(notificationIds) || notificationIds.length > 100 ||
        notificationIds.some((id) => typeof id !== "string" || !id || id.length > 200)) {
        return reply.code(400).send({
          error: "notificationIds must contain at most 100 notification IDs",
        });
      }
      const cursor = options.workspace.cursor();
      const acknowledged = options.workspace.acknowledgeNotifications(
        [...new Set(notificationIds as string[])],
      );
      options.publishWorkspaceSince(cursor);
      return { acknowledged };
    },
  );

  app.post<{ Body: { notificationIds?: unknown } }>(
    "/api/notifications/read-batch",
    async (request, reply) => {
      const notificationIds = request.body?.notificationIds;
      if (!Array.isArray(notificationIds) || notificationIds.length > 100 ||
        notificationIds.some((id) => typeof id !== "string" || !id || id.length > 200)) {
        return reply.code(400).send({
          error: "notificationIds must contain at most 100 notification IDs",
        });
      }
      const cursor = options.workspace.cursor();
      let read = 0;
      for (const id of new Set(notificationIds as string[])) {
        if (options.workspace.readNotification(id)) read += 1;
      }
      options.publishWorkspaceSince(cursor);
      return { read };
    },
  );

  app.post<{ Body: { communicationEventIds?: unknown } }>(
    "/api/notifications/read-visible",
    async (request, reply) => {
      const communicationEventIds = request.body?.communicationEventIds;
      if (!Array.isArray(communicationEventIds) || communicationEventIds.length > 100 ||
        communicationEventIds.some((id) => typeof id !== "string" || !id || id.length > 200)) {
        return reply.code(400).send({
          error: "communicationEventIds must contain at most 100 Communication event IDs",
        });
      }
      const cursor = options.workspace.cursor();
      const read = options.workspace.readNotificationsForCommunicationEvents(
        [...new Set(communicationEventIds as string[])],
      );
      options.publishWorkspaceSince(cursor);
      return { read };
    },
  );

}

export function registerPushRoutes(
  app: FastifyInstance,
  options: PushRoutesOptions,
): void {
  app.get<{ Querystring: { deviceId?: string } }>("/api/push/status", async (request) => ({
    configured: options.configuration.configured,
    configuration: options.configuration.state,
    detail: options.configuration.detail,
    ...(options.configuration.configured ? { publicKey: options.configuration.publicKey } : {}),
    ...(request.query.deviceId
      ? { deviceRegistered: options.workspace.hasPushSubscription(request.query.deviceId) }
      : {}),
  }));

  app.put<{ Params: { deviceId: string }; Body: WebPushSubscriptionDto }>(
    "/api/push/subscriptions/:deviceId",
    async (request, reply) => {
      const deviceId = request.params.deviceId.trim();
      const subscription = request.body;
      if (!options.configuration.configured) {
        return reply.code(503).send({ error: "web push is not configured on this host" });
      }
      if (!deviceId || deviceId.length > 200 || subscription?.deviceId !== deviceId) {
        return reply.code(400).send({ error: "device identity is invalid" });
      }
      let endpoint: URL;
      try {
        endpoint = new URL(subscription.endpoint);
      } catch {
        return reply.code(400).send({ error: "push endpoint is invalid" });
      }
      if (endpoint.protocol !== "https:" || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return reply.code(400).send({
          error: "a secure push endpoint and encryption keys are required",
        });
      }
      const cursor = options.workspace.cursor();
      options.workspace.putPushSubscription({
        deviceId,
        endpoint: endpoint.toString(),
        expirationTime: subscription.expirationTime ?? null,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
      });
      options.publishWorkspaceSince(cursor);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { deviceId: string } }>(
    "/api/push/subscriptions/:deviceId",
    async (request, reply) => {
      const cursor = options.workspace.cursor();
      options.workspace.deletePushSubscription(request.params.deviceId);
      options.publishWorkspaceSince(cursor);
      return reply.code(204).send();
    },
  );
}
