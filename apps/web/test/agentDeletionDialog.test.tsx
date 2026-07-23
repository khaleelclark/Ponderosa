import { Button } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { AgentDeletionDialog } from "../src/components/AgentDeletionDialog";
import { queryKeys } from "../src/queryKeys";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Dialog: forwardRef<HTMLDivElement, { open: boolean; children?: React.ReactNode }>(({ open, children }, ref) =>
      open ? createElement("div", { ref }, children) : null),
    Button: forwardRef<HTMLButtonElement, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      createElement("button", { ...props, ref }, children)),
  };
});

describe("Agent deletion confirmation", () => {
  it("commits the exact server preview instead of a client-computed cascade", async () => {
    const preview = {
      projectId: "project-1",
      rootAgentIds: ["manager"],
      affectedAgents: [
        { id: "manager", title: "Manager" },
        { id: "late-child", title: "Late child", managerAgentId: "manager" },
      ],
      previewHash: "a".repeat(64),
    };
    vi.spyOn(api, "previewAgentDeletion").mockResolvedValue(preview);
    const commit = vi.spyOn(api, "commitAgentDeletion").mockResolvedValue({
      deleted: true,
      deletedAgentIds: ["manager", "late-child"],
      deletionReceiptId: "receipt-1",
      cleanupPending: false,
    });
    const onDeleted = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const collaborationKey = queryKeys.collaboration("team-chat", 100);
    client.setQueryData(collaborationKey, { messages: [{ id: "deleted-agent-message" }] });
    expect(client.getQueryState(collaborationKey)?.isInvalidated).toBe(false);
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><AgentDeletionDialog
        open
        projectId="project-1"
        rootAgentIds={["manager"]}
        onClose={() => undefined}
        onDeleted={onDeleted}
      /></QueryClientProvider>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(JSON.stringify(view.toJSON())).toContain("Late child");
    expect(JSON.stringify(view.toJSON())).toContain("Project artifacts");
    const deleteButton = view.root.findAllByType(Button).find((button) => button.props.color === "error")!;
    await act(async () => { deleteButton.props.onClick(); });

    expect(commit).toHaveBeenCalledWith("project-1", {
      rootAgentIds: ["manager"],
      previewHash: preview.previewHash,
    });
    expect(onDeleted).toHaveBeenCalledWith(["manager", "late-child"]);
    expect(client.getQueryState(collaborationKey)?.isInvalidated).toBe(true);
    view.unmount();
    client.clear();
  });
});
