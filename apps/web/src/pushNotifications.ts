import type { WebPushStatusDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { api } from "./api";
import { createClientId } from "./clientId";

const DEVICE_KEY = "ponderosa.push.device.v1";
const STATUS_SIGNAL_KEY = "ponderosa.push.status-changed.v1";
let fallbackDeviceId: string | undefined;

export type WebPushState =
  | { kind: "unsupported"; message: string }
  | { kind: "insecure_origin"; message: string }
  | { kind: "permission_default"; message: string }
  | { kind: "permission_denied"; message: string }
  | { kind: "host_unconfigured"; message: string; setupCommand?: string }
  | { kind: "permission_granted"; message: string }
  | { kind: "subscription_failed"; message: string }
  | { kind: "active"; message: string };

/** A disabled action must explain the prerequisite that prevents it. */
export function webPushEnableBlockReason(state: WebPushState): string | undefined {
  switch (state.kind) {
    case "host_unconfigured":
    case "unsupported":
    case "insecure_origin":
    case "permission_denied":
      return state.message;
    default:
      return undefined;
  }
}

interface WebPushPrerequisites {
  supported: boolean;
  secure: boolean;
  permission: NotificationPermission | "unsupported";
}

export function classifyWebPushState(
  prerequisites: WebPushPrerequisites,
  host?: WebPushStatusDto,
  deviceActive = false,
  failure?: string,
): WebPushState {
  if (!prerequisites.supported) return { kind: "unsupported", message: "This browser does not support Web Push." };
  if (!prerequisites.secure) return { kind: "insecure_origin", message: "Browser push requires HTTPS or localhost. Open Ponderosa from a secure origin." };
  if (host && host.configuration !== "active") return {
    kind: "host_unconfigured",
    message: host.detail ?? (host.configuration === "invalid" ? "This host's Web Push configuration is invalid." : "Web Push is not set up on this host."),
    ...(host.setupCommand ? { setupCommand: host.setupCommand } : {}),
  };
  if (failure) return { kind: "subscription_failed", message: `Push subscription failed: ${failure} Retry from this device.` };
  if (prerequisites.permission === "denied") return { kind: "permission_denied", message: "Browser notification permission is blocked. Allow notifications in this site's browser settings." };
  if (prerequisites.permission === "default") return { kind: "permission_default", message: "Browser notification permission has not been requested. Enable push when you are ready." };
  if (deviceActive) return { kind: "active", message: "Browser push is active for this device." };
  return { kind: "permission_granted", message: "Permission is granted, but this device is not subscribed yet." };
}

function prerequisites(): WebPushPrerequisites {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    typeof window !== "undefined" && "PushManager" in window && typeof Notification !== "undefined";
  return {
    supported,
    secure: typeof window !== "undefined" && window.isSecureContext,
    permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  };
}

function webPushDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const created = createClientId("", () => `device-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    window.localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    // A stable ID for this loaded tab still lets registration work when browser
    // storage is unavailable. Endpoint deduplication prevents duplicates later.
    fallbackDeviceId ??= createClientId("ephemeral-", () => String(Date.now()));
    return fallbackDeviceId;
  }
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = window.atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sameApplicationServerKey(subscription: PushSubscription, expected: Uint8Array<ArrayBuffer>): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((value, index) => value === expected[index]);
}

function signalStatusChanged(): void {
  try { window.localStorage.setItem(STATUS_SIGNAL_KEY, String(Date.now())); } catch { /* storage may be unavailable */ }
  window.dispatchEvent(new Event("ponderosa-push-status-changed"));
}

export function subscribeWebPushChanges(listener: () => void): () => void {
  const local = () => listener();
  const storage = (event: StorageEvent) => { if (event.key === STATUS_SIGNAL_KEY) listener(); };
  window.addEventListener("ponderosa-push-status-changed", local);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener("ponderosa-push-status-changed", local);
    window.removeEventListener("storage", storage);
  };
}

export async function inspectWebPush(): Promise<WebPushState> {
  const initial = prerequisites();
  if (!initial.supported || !initial.secure) return classifyWebPushState(initial);
  try {
    const status = await api.getWebPushStatus(webPushDeviceId());
    if (status.configuration !== "active" || initial.permission !== "granted") return classifyWebPushState(initial, status);
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    const keyMatches = Boolean(subscription && status.publicKey && sameApplicationServerKey(subscription, applicationServerKey(status.publicKey)));
    return classifyWebPushState(initial, status, Boolean(keyMatches && status.deviceRegistered));
  } catch (error) {
    return classifyWebPushState(initial, undefined, false, error instanceof Error ? error.message : "Could not check this device.");
  }
}

export async function syncWebPush(requestPermission: boolean): Promise<WebPushState> {
  let current = prerequisites();
  if (!current.supported || !current.secure) return classifyWebPushState(current);
  let status: WebPushStatusDto;
  try {
    status = await api.getWebPushStatus(webPushDeviceId());
  } catch (error) {
    return classifyWebPushState(current, undefined, false, error instanceof Error ? error.message : "Host status is unavailable.");
  }
  if (status.configuration !== "active" || !status.publicKey) return classifyWebPushState(current, status);
  if (current.permission === "default" && requestPermission) {
    try {
      await Notification.requestPermission();
    } catch (error) {
      return classifyWebPushState(current, status, false, error instanceof Error ? error.message : "The permission request failed.");
    }
    current = prerequisites();
  }
  if (current.permission !== "granted") return classifyWebPushState(current, status);
  try {
    const registration = await navigator.serviceWorker.ready;
    const expectedKey = applicationServerKey(status.publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameApplicationServerKey(subscription, expectedKey)) {
      await subscription.unsubscribe();
      await api.deleteWebPushSubscription(webPushDeviceId()).catch(() => undefined);
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expectedKey });
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("The browser returned an incomplete subscription.");
    await api.upsertWebPushSubscription({
      deviceId: webPushDeviceId(),
      endpoint: json.endpoint,
      expirationTime: json.expirationTime,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      updatedAt: new Date().toISOString(),
    });
    signalStatusChanged();
    return classifyWebPushState(current, status, true);
  } catch (error) {
    return classifyWebPushState(current, status, false, error instanceof Error ? error.message : "The browser rejected the subscription.");
  }
}

export async function disableWebPush(): Promise<WebPushState> {
  const current = prerequisites();
  if (!current.supported || !current.secure) return classifyWebPushState(current);
  try {
    const status = await api.getWebPushStatus(webPushDeviceId());
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    await subscription?.unsubscribe();
    await api.deleteWebPushSubscription(webPushDeviceId());
    signalStatusChanged();
    return classifyWebPushState(current, status, false);
  } catch (error) {
    return classifyWebPushState(current, undefined, false, error instanceof Error ? error.message : "Could not remove this subscription.");
  }
}

/** Close OS notifications that became read through this or another open tab. */
export async function closeReadPushNotifications(notifications: WorkspaceNotificationDto[]): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const readIds = new Set(notifications.filter((item) => item.readAt).map((item) => item.id));
  if (readIds.size === 0) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const displayed = await registration.getNotifications();
    for (const notification of displayed) if (readIds.has(notification.tag)) notification.close();
  } catch { /* in-app read state remains canonical */ }
}
