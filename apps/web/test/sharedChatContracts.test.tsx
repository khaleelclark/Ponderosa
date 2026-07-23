import type { EngineDto } from "@ponderosa/core";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatAttachments } from "../src/components/chat/ChatAttachments";
import { ChatMessageFrame } from "../src/components/chat/ChatMessageFrame";
import { ChatSurface } from "../src/components/chat/ChatSurface";
import { useRuntimeControls } from "../src/hooks/useRuntimeControls";

function buttons(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root.findAll((node) =>
    node.type === "button"
    && node.children.some((child) => typeof child === "string" && child.includes(text)));
}

describe("shared chat presentation contracts", () => {
  it("renders the same author, reply, attachment, status, and action slots without surface booleans", () => {
    const html = renderToStaticMarkup(<ChatMessageFrame message={{
      id: "message-1",
      author: { kind: "agent", name: "Redwood", onOpen: vi.fn() },
      createdAt: "2026-07-23T10:00:00.000Z",
      reply: { text: "Original request", onOpen: vi.fn() },
      body: <p>Finished.</p>,
      afterBody: <ChatAttachments attachments={[
        { id: "pdf", agentId: "a", name: "report.pdf", mediaType: "application/pdf", size: 42, url: "/report" },
      ]} />,
      status: <span>Delivered</span>,
      actions: <button type="button">Copy</button>,
    }} />);

    expect(html).toContain('aria-label="Redwood message"');
    expect(html).toContain('aria-label="Go to replied-to message"');
    expect(html).toContain("report.pdf");
    expect(html).toContain('aria-label="Download report.pdf"');
    expect(html).toContain("Delivered");
    expect(html).toContain(">Copy</button>");
  });

  it("makes only selectable message rows button-like and keyboard activatable", () => {
    const onSelect = vi.fn();
    const selectable = create(<ChatMessageFrame message={{
      id: "message-selectable",
      author: { kind: "agent", name: "Redwood" },
      createdAt: "2026-07-23T10:00:00.000Z",
      body: <p>Select me.</p>,
      onSelect,
    }} />);
    const selectableArticle = selectable.root.findByType("article");
    expect(selectableArticle.props.role).toBe("button");
    expect(selectableArticle.props.tabIndex).toBe(0);

    const currentTarget = {};
    act(() => selectableArticle.props.onKeyDown({
      key: "Enter", target: currentTarget, currentTarget, preventDefault: vi.fn(),
    }));
    act(() => selectableArticle.props.onKeyDown({
      key: " ", target: currentTarget, currentTarget, preventDefault: vi.fn(),
    }));
    expect(onSelect).toHaveBeenCalledTimes(2);

    const transcript = create(<ChatMessageFrame message={{
      id: "message-transcript",
      author: { kind: "agent", name: "Redwood" },
      createdAt: "2026-07-23T10:00:00.000Z",
      body: <p>Read me.</p>,
    }} />);
    const transcriptArticle = transcript.root.findByType("article");
    expect(transcriptArticle.props.role).toBeUndefined();
    expect(transcriptArticle.props.tabIndex).toBeUndefined();
  });

  it("owns cursor pagination and prepares a stable prepend through one ChatSurface", () => {
    const loadEarlier = vi.fn();
    const view = create(<ChatSurface
      layout="agent"
      layoutKey="one"
      history={{ kind: "cursor", hasEarlier: true, loading: false, onLoadEarlier: loadEarlier }}
    >
      <div>Current message</div>
    </ChatSurface>);

    act(() => buttons(view.root, "Load Older History")[0]!.props.onClick());
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    expect(view.root.findByProps({ "aria-label": "Conversation" })).toBeTruthy();
  });
});

describe("canonical runtime control hook", () => {
  it("normalizes saved open-catalog selections and model-specific reasoning changes", () => {
    const engine = {
      id: "codex",
      displayName: "Codex",
      authenticated: true,
      available: true,
      models: [
        { id: "gpt-5", label: "GPT-5", efforts: [{ id: "high", label: "High" }], defaultEffort: "high" },
        { id: "gpt-6", label: "GPT-6", efforts: [{ id: "medium", label: "Medium" }], defaultEffort: "medium" },
      ],
      efforts: [],
      modelCatalogKnown: true,
    } as EngineDto;
    const selected: Array<{ model: string; effort: string }> = [];
    function Harness() {
      const runtime = useRuntimeControls({
        engine,
        selection: { model: "gpt-5", effort: "high" },
        onChange: (value) => selected.push(value),
      });
      return <button type="button" onClick={() => runtime.selectModel("gpt-6")}>
        {runtime.models.map((option) => option.label).join(",")} · {runtime.efforts.map((option) => option.label).join(",")}
      </button>;
    }
    const view = create(<Harness />);
    expect((view.toJSON() as { children: string[] }).children.join("")).toBe("GPT-5,GPT-6 · High");
    act(() => view.root.findByType("button").props.onClick());
    expect(selected).toEqual([{ model: "gpt-6", effort: "medium" }]);
  });
});
