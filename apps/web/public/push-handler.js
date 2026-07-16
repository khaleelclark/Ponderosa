self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { return; }
  event.waitUntil((async () => {
    // A push service may deliver again when its acknowledgement is ambiguous.
    // Retain a bounded receipt set after a successful display so reconnects or
    // server retries cannot create a second OS notification.
    let receipts;
    let receipt;
    if (payload.notificationId && "caches" in self) {
      receipts = await caches.open("ponderosa-push-receipts-v1");
      receipt = new Request(`${self.location.origin}/__push-receipts/${encodeURIComponent(payload.notificationId)}`);
      if (await receipts.match(receipt)) return;
    }
    await self.registration.showNotification(payload.title || "Ponderosa", {
      body: payload.body || "New activity",
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      tag: payload.notificationId,
      renotify: false,
      data: { url: payload.url || "/", notificationId: payload.notificationId },
    });
    if (receipts && receipt) {
      await receipts.put(receipt, new Response("delivered", { headers: { "content-type": "text/plain" } }));
      const keys = await receipts.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - 512)).map((key) => receipts.delete(key)));
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});
