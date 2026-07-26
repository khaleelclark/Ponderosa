// @vitest-environment node

import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCollaborationView } = vi.hoisted(() => ({
  getCollaborationView: vi.fn(async () => ({
    agents: [],
    messages: [],
    operations: [],
    history: { limit: 100, hasMore: false },
    operationHistory: { limit: 100, hasMore: false },
  })),
}));

vi.mock("../src/api", () => ({
  api: { getCollaborationView },
}));

import { useCollaborationView } from "../src/hooks/queries";

describe("Team Chat query admission", () => {
  beforeEach(() => getCollaborationView.mockClear());

  it("does not hydrate hidden Team Chat and fetches when the user opens it", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const Harness = ({ enabled }: { enabled: boolean }) => {
      useCollaborationView("conversation", 100, enabled);
      return null;
    };
    const render = (enabled: boolean) => createElement(
      QueryClientProvider,
      { client },
      createElement(Harness, { enabled }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(render(false));
      await Promise.resolve();
    });

    expect(getCollaborationView).not.toHaveBeenCalled();
    await act(async () => {
      renderer.update(render(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getCollaborationView).toHaveBeenCalledTimes(1);
    expect(getCollaborationView).toHaveBeenCalledWith("conversation", 100);
    renderer.unmount();
    client.clear();
  });
});
