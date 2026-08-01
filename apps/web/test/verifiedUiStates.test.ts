import { describe, expect, it } from "vitest";
import { triggerChatLabel, triggerScheduleStatus } from "../src/components/TriggersPane";
import { recordedPreviewLabel } from "../src/components/files/WorkspaceReviewPane";
import { classifyWebPushState, webPushEnableBlockReason } from "../src/pushNotifications";

describe("verified UI state helpers", () => {
  it("describes recorded previews without claiming metadata is previewable", () => {
    expect(recordedPreviewLabel({ diffAvailable: true })).toBe("Text preview available");
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
});
