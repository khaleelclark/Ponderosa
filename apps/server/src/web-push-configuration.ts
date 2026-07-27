import type { WorkspaceStore } from "@ponderosa/agents";
import webpush from "web-push";
import type { CreateServerOptions } from "./app-contracts.js";
import {
  WebPushDeliveryManager,
  type WebPushSender,
} from "./web-push-delivery.js";

export function createWebPushConfiguration(
  opts: CreateServerOptions,
  workspace: WorkspaceStore,
  publishWorkspaceSince: (cursor: number) => void,
) {

  const vapid = {
    publicKey: (opts.webPush?.publicKey ?? process.env.PONDEROSA_VAPID_PUBLIC_KEY)?.trim(),
    privateKey: (opts.webPush?.privateKey ?? process.env.PONDEROSA_VAPID_PRIVATE_KEY)?.trim(),
    subject: (opts.webPush?.subject ?? process.env.PONDEROSA_VAPID_SUBJECT)?.trim() || "mailto:admin@localhost",
  };
  let webPushConfiguration: "active" | "missing" | "invalid" = "missing";
  let webPushConfigurationDetail = "This host has no VAPID keypair. Run the setup command, then restart Ponderosa.";
  let webPushSender: WebPushSender | undefined;
  if (Boolean(vapid.publicKey) !== Boolean(vapid.privateKey)) {
    webPushConfiguration = "invalid";
    webPushConfigurationDetail = "The host VAPID configuration is incomplete. Regenerate the protected configuration file.";
  } else if (vapid.publicKey && vapid.privateKey) {
    try {
      if (!opts.webPush?.sender) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
      webPushSender = opts.webPush?.sender ?? {
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
    ...(opts.webPush?.retryDelaysMs ? { retryDelaysMs: opts.webPush.retryDelaysMs } : {}),
    ...(opts.webPush?.now ? { now: opts.webPush.now } : {}),
    ...(opts.webPush?.setTimer ? { setTimer: opts.webPush.setTimer } : {}),
    ...(opts.webPush?.clearTimer ? { clearTimer: opts.webPush.clearTimer } : {}),
  }) : undefined;
  return {
    vapid,
    webPushConfiguration,
    webPushConfigurationDetail,
    webPushConfigured,
    webPushDelivery,
  };
}
