self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { return; }
  event.waitUntil((async () => {
    if (payload.conversationId) {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const alreadyOpen = windows.some((client) => {
        if (client.visibilityState !== "visible") return false;
        const parts = new URL(client.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
        const projectMatches = !payload.projectId || (parts[0] === "projects" && parts[1] === payload.projectId);
        const conversationIndex = parts.findIndex((part) => part === "chats" || part === "conversations");
        return projectMatches && conversationIndex >= 0 && parts[conversationIndex + 1] === payload.conversationId;
      });
      if (alreadyOpen) return;
    }
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
    const sameOrigin = clients.filter((client) => new URL(client.url).origin === self.location.origin);
    const exact = sameOrigin.find((client) => new URL(client.url).href === target);
    if (exact) return exact.focus();
    const existing = sameOrigin.find((client) => client.visibilityState === "visible") || sameOrigin[0];
    if (existing) {
      existing.postMessage({ type: "ponderosa:open-route", url: target });
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});
