import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessageFrame } from "../src/components/chat/ChatMessageFrame";
import { Composer } from "../src/components/chat/Composer";

describe("composer surface ownership", () => {
  it("floats the shared composer above the viewport edge", () => {
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
      <Composer disabled={false} running={false} onSend={() => undefined} />
    </QueryClientProvider>);
    expect(html).toContain("width:calc(100% - 16px)");
    expect(html).toContain("max-width:100%");
    expect(html).not.toContain("position:sticky");
  });

  it("keeps the active-turn actions explicit and presents chat as an open transcript", () => {
    const html = renderToStaticMarkup(<ChatMessageFrame message={{
      id: "message-1",
      author: { kind: "operator" },
      createdAt: "2026-07-23T10:00:00.000Z",
      body: <p>Open transcript message</p>,
      actions: <button type="button">Copy</button>,
    }} />);
    expect(html).toContain('class="chat-message');
    expect(html).toContain('data-message-bubble="true"');
    expect(html).toContain("Open transcript message");
    expect(html).toContain(">Copy</button>");
    expect(html).toContain("max-width:94%");
    expect(html).toContain("max-width:min(78%, 780px)");
  });

});
// @vitest-environment node
