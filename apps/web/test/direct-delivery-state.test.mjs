import assert from "node:assert/strict";
import test from "node:test";
import { activeDirectDeliveryAgentIds } from "../src/components/directDeliveryState.js";

test("settled direct-message replays do not start a client operation", () => {
  assert.deepEqual(activeDirectDeliveryAgentIds({
    messageId: "message-a",
    replayed: true,
    recipients: [
      { agentId: "delivered", queued: false, state: "delivered" },
      { agentId: "failed", queued: false, state: "failed" },
      { agentId: "active", queued: false, state: "started" },
    ],
  }), ["active"]);
});
