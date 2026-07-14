import { api } from "./api";

const DEVICE_KEY = "ponderosa.push.device.v1";

function deviceId(): string {
  const existing = window.localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = globalThis.crypto.randomUUID();
  window.localStorage.setItem(DEVICE_KEY, created);
  return created;
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = window.atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function syncWebPush(requestPermission: boolean): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
    throw new Error("Web Push is not supported by this browser. In-app notifications remain enabled.");
  }
  const status = await api.getWebPushStatus();
  if (!status.configured || !status.publicKey) throw new Error("Web Push is not configured on this Ponderosa host.");
  let permission = Notification.permission;
  if (permission === "default" && requestPermission) permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Browser notification permission was denied." : "Browser notification permission has not been granted.");
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(status.publicKey),
  });
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("The browser returned an incomplete push subscription.");
  await api.upsertWebPushSubscription({
    deviceId: deviceId(),
    endpoint: json.endpoint,
    expirationTime: json.expirationTime,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    updatedAt: new Date().toISOString(),
  });
  return "Browser push is enabled for this device.";
}

export async function disableWebPush(): Promise<string> {
  if (!("serviceWorker" in navigator)) return "Browser push is unavailable on this device.";
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager?.getSubscription();
  await subscription?.unsubscribe();
  const id = window.localStorage.getItem(DEVICE_KEY);
  if (id) await api.deleteWebPushSubscription(id);
  return "Browser push is disabled for this device. In-app notifications remain available.";
}
