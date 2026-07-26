// @vitest-environment node

import type { ArtifactDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactsPane } from "../src/components/filePreview/ArtifactsPane";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("command activity copy", () => {
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
