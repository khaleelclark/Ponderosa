import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageDeliveryStatus } from "../src/components/MessageDeliveryStatus";

function render(receipts: Parameters<typeof MessageDeliveryStatus>[0]["receipts"], link = false): string {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>
    <MessageDeliveryStatus receipts={receipts} recipientName={() => "Manager"} onOpenAgent={link ? () => undefined : undefined} />
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
      recoveryAt: "2099-07-16T00:00:10.000Z",
      canLetCurrentRunFinish: true,
    }]);
    expect(html).toContain("Delivery to Manager is unconfirmed");
    expect(html).toContain("Let current Run finish");
  });

  it("labels historical uncertainty as undelivered without offering replay", () => {
    const html = render([{
      activationId: "historical",
      targetAgentId: "manager",
      injectionId: "old-injection",
      state: "undelivered",
      updatedAt: "2026-07-15T00:00:00.000Z",
    }]);
    expect(html).toContain("Undelivered to Manager");
    expect(html).not.toContain("Let current Run finish");
  });

  it("links compact status text to the recipient's direct chat", () => {
    const html = render([{
      activationId: "processed",
      targetAgentId: "manager",
      state: "processed",
      updatedAt: "2026-07-16T00:00:00.000Z",
    }], true);
    expect(html).toContain("Processed by Manager");
    expect(html).toContain("Open direct chat with Manager");
    expect(html).not.toContain("MuiAlert-root");
  });
});
