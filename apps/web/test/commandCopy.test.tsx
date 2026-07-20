import type { ArtifactContentDto, ArtifactDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
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

  it("uses the Agent code-block copy control for commands in Files & Results", async () => {
    const command = "pnpm --filter @ponderosa/web test";
    const artifact = {
      id: "command-artifact",
      agentId: "agent-1",
      kind: "log",
      path: "000001-command.md",
      summary: command,
      createdAt: "2026-07-20T12:00:00.000Z",
    } satisfies ArtifactDto;
    const content = {
      ...artifact,
      content: `# Command\n\n\`\`\`bash\n${command}\n\`\`\`\n\ncwd: \`/repo\`\n`,
      contentType: "markdown",
    } satisfies ArtifactContentDto;
    vi.spyOn(api, "getArtifact").mockResolvedValue(content);
    vi.mocked(copyText).mockResolvedValue();
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
    await vi.waitFor(() => expect(view.root.findByProps({ "aria-label": "Copy code" })).toBeTruthy());
    await act(async () => view.root.findByProps({ "aria-label": "Copy code" }).props.onClick());

    expect(copyText).toHaveBeenCalledWith(command);
    view.unmount();
    client.clear();
  });
});
