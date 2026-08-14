import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { MessageDeliveryReceiptDto } from "@ponderosa/core";
import { afterEach, describe, expect, it } from "vitest";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";

afterEach(cleanup);

describe("MessageDeliveryStatus", () => {
  it("shows required-reply exhaustion with the authoritative attempt count and recovery action", () => {
    const receipt: MessageDeliveryReceiptDto = {
      activationId: "activation-exhausted",
      targetAgentId: "agent-1",
      state: "retry_exhausted",
      updatedAt: "2026-08-14T00:00:05.500Z",
      attemptCount: 6,
      canRetry: true,
      retryMayDuplicate: true,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MessageDeliveryStatus
          projectId="project-1"
          receipts={[receipt]}
          recipientName={() => "Agent One"}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("status", {
      name: "Required reply from Agent One was not published after 6 attempts; automatic recovery stopped.",
    })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try Delivery Again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel Delivery" })).toBeTruthy();
  });
});
