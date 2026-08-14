import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentWorkItemDto } from "@ponderosa/core";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkTechnicalDetails } from "./AgentWorkInspector";

afterEach(cleanup);

describe("Agent work technical details", () => {
  it("renders only the canonical public provider diagnostic supplied by the DTO", () => {
    const item: AgentWorkItemDto = {
      id: "run:run-1",
      recordId: "run-1",
      referenceIds: [],
      kind: "run",
      state: "failed",
      title: "Failed Run",
      summary: "Provider execution failed.",
      agentIds: ["agent-1"],
      relatedItemIds: [],
      details: [
        { label: "Provider failure summary", value: "Provider authentication was rejected." },
        {
          label: "Operator action",
          value: "Review provider access and retry the affected work when the provider is available.",
        },
      ],
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:01.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(<QueryClientProvider client={queryClient}>
      <AgentWorkTechnicalDetails projectId="project-1" item={item} />
    </QueryClientProvider>);

    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Provider authentication was rejected.")).toBeTruthy();
    expect(screen.getByText(/Review provider access and retry/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /Raw fields|provider data|AUTHENTICATION_FAILURE|Basic|password|access_token|auth\.json|private-/u,
    );
  });
});
