import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageDeliveryStatus } from "../src/components/MessageDeliveryStatus";

function render(receipts: Parameters<typeof MessageDeliveryStatus>[0]["receipts"], link = false): string {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>
    <MessageDeliveryStatus projectId="project-a" receipts={receipts} recipientName={() => "Manager"} onOpenAgent={link ? () => undefined : undefined} />
  </QueryClientProvider>);
  client.clear();
  return html;
}

describe("message delivery status", () => {
  it("shows the live uncertainty countdown and the explicit non-interrupting choice", () => {
    const html = render([{
      activationId: "activation",
      targetAgentId: "manager",
      injectionId: "injection",
      state: "unconfirmed",
      updatedAt: "2026-07-16T00:00:00.000Z",
      attemptCount: 1,
      recoveryAt: "2099-07-16T00:00:10.000Z",
      canLetCurrentRunFinish: true,
    }]);
    expect(html).toContain("Delivery to Manager is unconfirmed");
    expect(html).toContain("Let current Run finish");
  });

  it("offers a guarded retry for historical uncertainty", () => {
    const html = render([{
      activationId: "historical",
      targetAgentId: "manager",
      injectionId: "old-injection",
      state: "undelivered",
      updatedAt: "2026-07-15T00:00:00.000Z",
      attemptCount: 1,
      canRetry: true,
      retryMayDuplicate: true,
    }]);
    expect(html).toContain("Undelivered to Manager");
    expect(html).not.toContain("Let current Run finish");
    expect(html).toContain("Retry");
  });

  it("links compact status text to the recipient's direct chat", () => {
    const html = render([{
      activationId: "processed",
      targetAgentId: "manager",
      state: "processed",
      updatedAt: "2026-07-16T00:00:00.000Z",
      attemptCount: 1,
    }], true);
    expect(html).toContain("Processed by Manager");
    expect(html).toContain("Open direct chat with Manager");
    expect(html).not.toContain("MuiAlert-root");
  });
});
