import type { ArtifactDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../src/clipboard";
import { ArtifactsPane, EventLine } from "../src/components/panes";

vi.mock("../src/clipboard", () => ({ copyText: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("command activity copy", () => {
  it("copies the exact command and announces accessible success feedback", async () => {
    vi.mocked(copyText).mockResolvedValue();
    const view = create(<EventLine item={{
      id: "command-1",
      seq: 7,
      ts: "2026-07-20T12:00:00.000Z",
      event: { type: "command", command: "pnpm --filter @ponderosa/web test", cwd: "/repo" },
    }} />);

    const copy = view.root.findByProps({ "aria-label": "Copy command" });
    await act(async () => copy.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() }));

    expect(copyText).toHaveBeenCalledWith("pnpm --filter @ponderosa/web test");
    expect(view.root.findByProps({ "aria-live": "polite" }).props.children).toBe("Command copied");
    view.unmount();
  });

  it("keeps command artifacts out of Files & Results because Activity owns them", async () => {
    const artifact = {
      id: "command-artifact",
      agentId: "agent-1",
      kind: "log",
      path: "000001-command.md",
      summary: "pnpm --filter @ponderosa/web test",
      createdAt: "2026-07-20T12:00:00.000Z",
    } satisfies ArtifactDto;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;

    await act(async () => {
      view = create(<QueryClientProvider client={client}><ArtifactsPane
        artifacts={[artifact]}
        agentId="agent-1"
        agentTitle="Cabrillo"
        timeline={[]}
        onOpenRun={vi.fn()}
      /></QueryClientProvider>);
    });
    expect(JSON.stringify(view.toJSON())).toContain("command output is available in Activity");
    view.unmount();
    client.clear();
  });
});
