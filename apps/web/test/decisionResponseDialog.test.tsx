// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { DecisionActions } from "../src/components/decisions/DecisionActions";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  return {
    ...actual,
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  };
});

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.findAll((node) =>
    node.type === "button"
    && node.children.some((child) => typeof child === "string" && child.includes(label)))[0]!;
}

describe("Decision response UI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the shared dialog for free-text responses and submits trimmed text without a native prompt", async () => {
    const respond = vi.spyOn(api, "respondDecision").mockResolvedValue({
      id: "decision-1",
      status: "resolved",
    } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = create(<QueryClientProvider client={client}><DecisionActions decision={{
      id: "decision-1",
      mode: "choice",
      options: [{ id: "approve", label: "Approve" }],
      allowOther: true,
      status: "pending",
      question: "How should the Agent continue?",
      context: "This changes only the current assignment.",
    }} /></QueryClientProvider>);

    act(() => button(view.root, "Something Else").props.onClick({ stopPropagation: vi.fn() }));
    expect(view.root.findByProps({ role: "dialog" })).toBeTruthy();
    const input = view.root.findByProps({ label: "Alternative direction" });
    act(() => input.props.onChange({ target: { value: "  Use the safer path.  " } }));
    await act(async () => button(view.root, "Send Response").props.onClick());

    expect(respond).toHaveBeenCalledWith("decision-1", { text: "Use the safer path." });
  });
});
