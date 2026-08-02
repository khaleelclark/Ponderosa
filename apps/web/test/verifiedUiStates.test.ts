import { describe, expect, it } from "vitest";
import { triggerChatLabel, triggerChatOptionLabel, triggerChatQueryLabel, triggerScheduleStatus } from "../src/components/TriggersPane";
import { recordedPreviewLabel } from "../src/components/files/WorkspaceReviewPane";
import { receiptActivityEntry } from "../src/components/chat/AgentWorkReceipt";
import { coalesceTeamOperationalEvents } from "../src/components/teamChatPresentation";
import { classifyWebPushState, webPushEnableBlockReason } from "../src/pushNotifications";

describe("verified UI state helpers", () => {
  it("describes recorded previews without claiming metadata is previewable", () => {
    expect(recordedPreviewLabel({ diffAvailable: true })).toBe("Text preview recorded");
    expect(recordedPreviewLabel({ diffAvailable: false })).toBe("Metadata and provenance only");
  });

  it("blocks unusable push prerequisites with the visible reason", () => {
    expect(webPushEnableBlockReason({
      kind: "host_unconfigured",
      message: "This host has no VAPID keypair.",
      setupCommand: "configure-push",
    })).toBe("This host has no VAPID keypair.");
    expect(webPushEnableBlockReason({
      kind: "permission_default",
      message: "Permission has not been requested.",
    })).toBeUndefined();
  });

  it("classifies every visible Browser Push result", () => {
    const ready = { supported: true, secure: true, permission: "granted" as const };
    expect(classifyWebPushState({ ...ready, supported: false }).kind).toBe("unsupported");
    expect(classifyWebPushState({ ...ready, permission: "denied" }).kind).toBe("permission_denied");
    expect(classifyWebPushState(ready, {
      configured: false,
      configuration: "missing",
      deviceRegistered: false,
    }).kind).toBe("host_unconfigured");
    expect(classifyWebPushState(ready, undefined, false, "network failed").kind).toBe("subscription_failed");
    expect(classifyWebPushState(ready, {
      configured: true,
      configuration: "active",
      deviceRegistered: true,
      publicKey: "key",
    }, true).kind).toBe("active");
  });

  it("uses current Chat titles and an intentional unavailable tombstone", () => {
    const chats = [{ id: "chat-1", title: "Renamed UX Audit Chat" }];
    expect(triggerChatLabel("chat-1", chats)).toBe("Renamed UX Audit Chat");
    expect(triggerChatLabel("deleted-chat", chats)).toBe("Unavailable Chat");
    expect(triggerChatLabel("chat-1", [{ ...chats[0]!, deletedAt: "2026-08-01T12:00:00.000Z" }])).toBe("Unavailable Chat");
    expect(triggerChatQueryLabel("chat-1", chats, { isLoading: false, isError: true })).toBe("Chat name unavailable");
    expect(triggerChatOptionLabel("Renamed UX Audit Chat", true)).toBe("Primary · Renamed UX Audit Chat");
  });

  it("never presents a disabled Trigger timestamp as upcoming", () => {
    expect(triggerScheduleStatus({
      enabled: false,
      sourceKind: "schedule",
      nextFireAt: "2026-08-01T12:00:00.000Z",
    })).toBe("Not scheduled while disabled");
    expect(triggerScheduleStatus({
      enabled: true,
      sourceKind: "schedule",
      nextFireAt: "2026-08-01T12:00:00.000Z",
    })).toContain("Next scheduled occurrence:");
  });

  it("puts a failed message attempt in the completed task context", () => {
    const entry = receiptActivityEntry({
      id: "tool-1",
      seq: 10,
      createdAt: "2026-08-01T12:00:00.000Z",
      kind: "tool",
      name: "ponderosa_message",
      input: { text: "Done" },
      result: {
        activityId: "result-1",
        agentId: "agent-1",
        seq: 11,
        completedAt: "2026-08-01T12:00:01.000Z",
        output: "delivery failed",
        isError: true,
      },
    }, "completed");
    expect(entry).toMatchObject({
      kind: "notice",
      title: "Message delivery failed; task completed",
    });
  });

  it("coalesces one terminal coordination transaction without hiding distinct cancellations", () => {
    const event = (
      id: string,
      kind: "request" | "activation",
      updatedAt: string,
      operationGroupId: string,
    ) => ({
      id,
      kind,
      operationGroupId,
      state: "cancelled",
      attentionRequired: true,
      text: kind === "request" ? "Pine's work for Oak ended cancelled" : "Pine stopped",
      agentIds: kind === "request" ? ["oak", "pine"] : ["pine"],
      createdAt: updatedAt,
      updatedAt,
    });
    const presented = coalesceTeamOperationalEvents([
      event("request:1", "request", "2026-08-01T12:00:00.000Z", "request:1"),
      event("activation:1", "activation", "2026-08-01T12:00:00.000Z", "request:1"),
      event("request:2", "request", "2026-08-01T12:00:00.000Z", "request:2"),
      event("activation:2", "activation", "2026-08-01T12:00:00.000Z", "request:2"),
    ]);
    expect(presented).toHaveLength(2);
    expect(presented.map(item => item.relatedLifecycleCount)).toEqual([2, 2]);
    expect(presented.map(item => item.kind)).toEqual(["request", "request"]);
  });

});
