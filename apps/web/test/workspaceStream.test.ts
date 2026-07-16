import { describe, expect, it } from "vitest";
import { conversationChangedQueryKeys, reconcileWorkspaceCursor } from "../src/hooks/useWorkspaceStream";

describe("workspace stream cursor recovery", () => {
  it("converges independent tabs after sleep/reconnect and ignores duplicate replay", () => {
    let phone = 0;
    let desktop = 0;
    const events = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

    // Desktop remained connected; the phone wakes with a stale cursor and gets
    // a live event before the server's resumable backfill arrives.
    desktop = reconcileWorkspaceCursor(desktop, events[0]!).cursor;
    desktop = reconcileWorkspaceCursor(desktop, events[1]!).cursor;
    phone = reconcileWorkspaceCursor(phone, events[0]!).cursor;
    const outOfOrder = reconcileWorkspaceCursor(phone, events[2]!);
    expect(outOfOrder.gap).toBe(true);
    phone = outOfOrder.cursor;

    // Backfill is idempotent: the already-applied event is ignored, then both
    // tabs consume the remaining canonical tail.
    expect(reconcileWorkspaceCursor(phone, events[1]!).duplicate).toBe(true);
    phone = reconcileWorkspaceCursor(phone, events[3]!).cursor;
    desktop = reconcileWorkspaceCursor(desktop, events[2]!).cursor;
    desktop = reconcileWorkspaceCursor(desktop, events[3]!).cursor;
    expect(phone).toBe(desktop);
    expect(reconcileWorkspaceCursor(phone, events[3]!).duplicate).toBe(true);
  });

  it("invalidates Project and Team chat in every tab for a canonical message or edit", () => {
    const event = {
      type: "conversation_changed" as const,
      projectId: "project-1",
      conversationId: "conversation-1",
      action: "updated" as const,
    };
    const desktop = conversationChangedQueryKeys(event);
    const phoneAfterReconnect = conversationChangedQueryKeys(event);

    expect(desktop).toEqual([
      ["conversations", "project-1"],
      ["conversation", "conversation-1"],
      ["collaboration-chat", "conversation-1"],
    ]);
    expect(phoneAfterReconnect).toEqual(desktop);
  });
});
