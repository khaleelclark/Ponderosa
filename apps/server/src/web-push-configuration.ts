import type { WorkspaceStore } from "@ponderosa/agents";
import webpush from "web-push";
import {
  WebPushDeliveryManager,
  type WebPushSender,
} from "./web-push-delivery.js";

export function createWebPushConfiguration(
  workspace: WorkspaceStore,
  publishWorkspaceSince: (cursor: number) => void,
) {

  const vapid = {
    publicKey: process.env.PONDEROSA_VAPID_PUBLIC_KEY?.trim(),
    privateKey: process.env.PONDEROSA_VAPID_PRIVATE_KEY?.trim(),
    subject: process.env.PONDEROSA_VAPID_SUBJECT?.trim() || "mailto:admin@localhost",
  };
  let webPushConfiguration: "active" | "missing" | "invalid" = "missing";
  let webPushConfigurationDetail = "This host has no VAPID keypair. Run the setup command, then restart Ponderosa.";
  let webPushSender: WebPushSender | undefined;
  if (Boolean(vapid.publicKey) !== Boolean(vapid.privateKey)) {
    webPushConfiguration = "invalid";
    webPushConfigurationDetail = "The host VAPID configuration is incomplete. Regenerate the protected configuration file.";
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
      webPushConfigurationDetail = "The host VAPID configuration is invalid. Regenerate the protected configuration file.";
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
