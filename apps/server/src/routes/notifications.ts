import {
  notificationInProduct,notificationProductPredicate,
  requestProduct,
} from "../product-scope.js";
import type { AgentStore, ProductScope, WorkspaceStore } from "@ponderosa/agents";
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
  readonly store: Pick<AgentStore, "getAgentTitleProjection" | "getProject" | "getConversation" | "sqlite">;
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

/** Shared bounded notification owner for the inbox and product Home previews. */
export function workspaceNotificationPage(
  options: Pick<NotificationRoutesOptions, "workspace" | "store">,
  product: ProductScope,
  input: Omit<Parameters<WorkspaceStore["listNotificationPage"]>[0], "include">,
): ReturnType<WorkspaceStore["listNotificationPage"]> {
  const page = options.workspace.listNotificationPage({...input,include:notificationProductPredicate(options.store,product)});
  const agentTitles = options.store.getAgentTitleProjection(page.items.flatMap(item=>item.agentId?[item.agentId]:[]));
  const projectLabels = new Map([...new Set(page.items.flatMap(item=>item.projectId?[item.projectId]:[]))]
    .map(id=>[id,options.store.getProject(id)?.label]));
  const chats = new Map([...new Set(page.items.flatMap(item=>item.conversationId?[item.conversationId]:[]))]
    .map(id=>[id,options.store.getConversation(id)]));
  const items = page.items.map(notification=>{
    const chatIds=notification.conversationId?[notification.conversationId]:notification.conversationIds??[];
    const owners=!notification.branchId&&product==='branches'
      ?chatIds.map(id=>options.store.sqlite.prepare('SELECT branch_id FROM conversations WHERE id=?').get(id) as {branch_id:string|null}|undefined):[];
    const branchId=owners.length&&owners.every(owner=>owner?.branch_id&&owner.branch_id===owners[0]?.branch_id)?owners[0]!.branch_id:undefined;
    const agentTitle=notification.agentId?agentTitles.get(notification.agentId):undefined;
    const projectLabel=notification.projectId?projectLabels.get(notification.projectId):undefined;
    const chat=notification.conversationId?chats.get(notification.conversationId):undefined;
    const conversationTitle=chat?.projectId===notification.projectId?chat?.title:undefined;
    return {...notification,...(branchId?{branchId}:{}),...(agentTitle?{agentTitle}:{}),...(projectLabel?{projectLabel}:{}),...(conversationTitle?{conversationTitle}:{})};
  });
  return {...page,items};
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
          product?: unknown;
          createdAt?: unknown;
          id?: unknown;
        };
        if (decoded.product !== requestProduct(request) || typeof decoded.createdAt !== "string" || decoded.createdAt.length > 64 ||
          typeof decoded.id !== "string" || !decoded.id || decoded.id.length > 200) {
          throw new Error("cursor fields are invalid");
        }
        before = { createdAt: decoded.createdAt, id: decoded.id };
      } catch {
        return reply.code(400).send({ error: "cursor is invalid" });
      }
    }
    const page = workspaceNotificationPage(options,requestProduct(request),{
      limit: requestedLimit,
      ...(before ? { before } : {}),
    });
    return {
      items:page.items,
      openActionCount: page.openActionCount,
      unacknowledgedActionCount: page.unacknowledgedActionCount,
      unreadUpdateCount: page.unreadUpdateCount,
      ...(page.nextCursor
        ? { nextCursor: Buffer.from(JSON.stringify({ ...page.nextCursor, product: requestProduct(request) })).toString("base64url") }
        : {}),
    } satisfies WorkspaceNotificationPageDto;
  });

  app.post<{ Body: { notificationIds?: unknown } }>("/api/notifications/active", async (request, reply) => {
    const notificationIds = request.body?.notificationIds;
    if (!Array.isArray(notificationIds) || notificationIds.length > 100 ||
      notificationIds.some((id) => typeof id !== "string" || !id || id.length > 200)) {
      return reply.code(400).send({ error: "notificationIds must contain at most 100 notification IDs" });
    }
    const product = requestProduct(request);
    const uniqueIds = [...new Set(notificationIds)];
    if (uniqueIds.some((id) => {
      const notification = options.workspace.getNotification(id);
      return !notification || !notificationInProduct(options.store, notification, product);
    })) return reply.code(404).send({ error: "notification not found" });
    return {
      activeNotificationIds: options.workspace.activeNotificationIds(uniqueIds),
    };
  });

  app.post<{ Body: Partial<WorkspaceNotificationProjectionRequestDto> }>(
    "/api/notifications/projection",
    async (request, reply) => {
      const projectIds = request.body?.projectIds;
      const conversationIds = request.body?.conversationIds;
      const chatFolders = request.body?.chatFolders;
      const validIds = (value: unknown): value is string[] => Array.isArray(value) &&
        value.length <= 200 &&
        value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200);
      if (!validIds(projectIds) || !validIds(conversationIds)) {
        return reply.code(400).send({
          error: "projectIds and conversationIds must each contain at most 200 IDs",
        });
      }
      if (chatFolders !== undefined) {
        let memberCount = 0;
        const folderIds = new Set<string>();
        if (!Array.isArray(chatFolders) || chatFolders.length > 200 || chatFolders.some(folder => {
          if (!folder || typeof folder.id !== "string" || !folder.id || folder.id.length > 200 || folderIds.has(folder.id) ||
            !Array.isArray(folder.conversationIds) || folder.conversationIds.length > 10_000) return true;
          folderIds.add(folder.id);
          memberCount += folder.conversationIds.length;
          return memberCount > 10_000 || folder.conversationIds.some(id => typeof id !== "string" || !id || id.length > 200);
        })) return reply.code(400).send({ error: "chatFolders must contain at most 200 unique groups and 10000 total member IDs" });
      }
      return options.workspace.notificationProjection({
        include: notificationProductPredicate(options.store,requestProduct(request)),
        projectIds: [...new Set(projectIds)],
        conversationIds: [...new Set(conversationIds)],
        ...(chatFolders ? { chatFolders } : {}),
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
      const dismissed = options.workspace.dismissNotifications(request.body.kind, notificationProductPredicate(options.store,requestProduct(request)));
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
      const existing = options.workspace.getNotification(request.params.id);
      if (!existing || !notificationInProduct(options.store, existing, requestProduct(request))) {
        return reply.code(404).send({ error: "notification not found" });
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
      const existing = options.workspace.getNotification(request.params.id);
      if (!existing || !notificationInProduct(options.store, existing, requestProduct(request))) {
        return reply.code(404).send({ error: "notification not found" });
      }
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
      const uniqueIds = [...new Set(notificationIds as string[])];
      const product = requestProduct(request);
      if (uniqueIds.some((id) => {
        const notification = options.workspace.getNotification(id);
        return !notification || !notificationInProduct(options.store, notification, product);
      })) return reply.code(404).send({ error: "notification not found" });
      const cursor = options.workspace.cursor();
      const acknowledged = options.workspace.acknowledgeNotifications(uniqueIds);
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
      const uniqueIds = [...new Set(notificationIds as string[])];
      const product = requestProduct(request);
      if (uniqueIds.some((id) => {
        const notification = options.workspace.getNotification(id);
        return !notification || !notificationInProduct(options.store, notification, product);
      })) return reply.code(404).send({ error: "notification not found" });
      const cursor = options.workspace.cursor();
      let read = 0;
      for (const id of uniqueIds) {
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
        notificationProductPredicate(options.store,requestProduct(request)),
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
