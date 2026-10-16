import type { WorkspaceStore } from "@ponderosa/agents";
import webpush from "web-push";
import {
  WebPushDeliveryManager,
  type WebPushSender,
} from "./web-push-delivery.js";
import { resolveWebPushVapid } from "./web-push-vapid.js";

export function createWebPushConfiguration(
  dataDir: string,
  workspace: WorkspaceStore,
  publishWorkspaceSince: (cursor: number) => void,
) {
  const resolved = resolveWebPushVapid(dataDir);
  const vapid = resolved.vapid;
  let webPushConfiguration: "active" | "missing" | "invalid" = "missing";
  let webPushConfigurationDetail = resolved.failure ?? "Ponderosa has not established its browser-push identity.";
  let webPushSender: WebPushSender | undefined;
  if (resolved.failure) {
    webPushConfiguration = "invalid";
  } else if (Boolean(vapid.publicKey) !== Boolean(vapid.privateKey)) {
    webPushConfiguration = "invalid";
    webPushConfigurationDetail = "The operator-provided browser-push identity is incomplete. Provide both VAPID keys or remove both overrides, then restart the Engine.";
  } else if (vapid.publicKey && vapid.privateKey) {
    try {
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
      webPushSender = {
        async send(subscription, payload, options) {
          await webpush.sendNotification(subscription, payload, options);
        },
      };
      webPushConfiguration = "active";
      webPushConfigurationDetail = "Host VAPID configuration is active.";
    } catch {
      webPushConfiguration = "invalid";
      webPushConfigurationDetail = "The browser-push identity is invalid. Correct the protected host configuration, then restart the Engine.";
    }
  }
  const webPushConfigured = webPushConfiguration === "active";
  const webPushDelivery = webPushSender ? new WebPushDeliveryManager({
    store: workspace,
    sender: webPushSender,
    onWorkspaceEvents: publishWorkspaceSince,
  }) : undefined;
  return {
    vapid,
    webPushConfiguration,
    webPushConfigurationDetail,
    webPushConfigured,
    webPushDelivery,
  };
}
