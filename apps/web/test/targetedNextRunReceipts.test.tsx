import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TargetedNextRunReceipts } from "../src/components/TargetedNextRunReceipts";

describe("TargetedNextRunReceipts", () => {
  it("shows the passive audience and durable per-recipient outcomes", () => {
    render(<TargetedNextRunReceipts receipts={[{
      deliveryId: "delivery-1",
      projectId: "project",
      conversationId: "chat",
      text: "Use this on your next run.",
      createdAt: "2026-08-07T00:00:00.000Z",
      recipients: [
        { agentId: "a", agentTitle: "Acadia", state: "pending" },
        { agentId: "b", agentTitle: "Birch", state: "delivered" },
        {
          agentId: "c",
          agentTitle: "Cedar",
          state: "unavailable",
          unavailableReason: "recipient Agent was deleted",
        },
      ],
    }]} />);

    expect(screen.getByText("Deliver on next run · Acadia, Birch, Cedar")).toBeTruthy();
    expect(screen.getByText("Passive delivery · no Run · no reply requested")).toBeTruthy();
    expect(screen.getByText("Acadia: Pending · delivers on next run")).toBeTruthy();
    expect(screen.getByText("Birch: Delivered")).toBeTruthy();
    expect(screen.getByText("Cedar: Unavailable")).toBeTruthy();
  });
});
