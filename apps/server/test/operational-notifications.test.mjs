import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceStore } from "@ponderosa/agents";
import { createOperationalNotifications } from "../dist/operational-notifications.js";
import { pushPayload } from "../dist/web-push-delivery.js";

test("an informational Branch notification queues and wakes browser push when explicitly requested", () => {
  const root = mkdtempSync(join(tmpdir(), "branch-push-"));
  try {
    const workspace = new WorkspaceStore(root);
    workspace.putPushSubscription({ deviceId: "phone", endpoint: "https://example.test/push", expirationTime: null, keys: { p256dh: "test", auth: "test" } });
    let wakes = 0;
    const notifications = createOperationalNotifications({
      store: {}, coordinationV3: {}, workspace,
      publishWorkspaceSince() {}, notifyWebPush() { wakes += 1; },
    });
    const notification = notifications.createOperationalNotification({
      dedupeKey: "branch-action:attempt", branchId: "branch", category: "system", severity: "info", push: true,
      title: "Workflow finished", body: "Result", action: { kind: "open_branch", targetId: "branch" },
    });
    assert.equal(notification.severity, "info");
    assert.equal("push" in notification, false);
    assert.equal(workspace.duePushDeliveries().length, 1);
    assert.equal(wakes, 1);
    assert.equal(pushPayload(notification).url, "/branches?branch=branch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
