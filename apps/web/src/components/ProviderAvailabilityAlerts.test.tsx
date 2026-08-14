import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EngineDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PROVIDER_DIAGNOSTIC_CHARACTERS } from "../providerAvailability";
import { ProjectCreationDialog } from "./ProjectCreationDialog";
import { ProviderAvailabilityAlerts } from "./ProviderAvailabilityAlerts";

function engine(id: string, overrides: Partial<EngineDto> = {}): EngineDto {
  return {
    id,
    displayName: id === "claude" ? "Claude" : id === "codex" ? "Codex" : id,
    models: [],
    efforts: [],
    configured: true,
    authentication: "authenticated",
    enabled: true,
    intakeReady: true,
    reachability: "reachable",
    ...overrides,
  };
}

const preferences = {
  projectSort: "last_used",
  projectOrder: [],
  starredProjectIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 280,
  notifications: { directResponses: true, broadcasts: true },
  fontFamily: "inter",
  providerAvailability: {},
  claudeModelOptions: [],
  globalInstructions: "",
  maxConcurrentAgentRuns: 4,
  contextRolloverEnabled: true,
  contextRolloverTokens: 100_000,
  contextRolloverWindowFraction: 0.8,
  onboardingCompletedAt: null,
  profile: { displayName: "Tester", handle: "tester", avatarId: "" },
  updatedAt: "2026-08-14T00:00:00.000Z",
} satisfies WorkspacePreferencesDto;

function renderDialog(engines: EngineDto[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <ProjectCreationDialog
      open
      engines={engines}
      preferences={preferences}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />
  </QueryClientProvider>);
}

afterEach(cleanup);

describe("Create Project provider availability", () => {
  it("associates a degraded Claude warning with Claude while healthy Codex remains selectable", () => {
    const raw = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      error: { message: "subscription expired" },
      session_id: "never-render-this-session-id",
    });
    renderDialog([
      engine("claude", { intakeReady: false, reachability: "degraded", availabilityDetail: raw }),
      engine("codex"),
    ]);

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-provider-id")).toBe("claude");
    expect(within(alert).getByText(/Claude access is unavailable/)).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Test Claude access" })).toBeTruthy();
    expect(screen.queryByText(/Codex access is unavailable/)).toBeNull();

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "AI Provider" }));
    expect(screen.getByRole("option", { name: "Codex" }).getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.getByRole("option", { name: "Claude — Unavailable" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps long and malformed diagnostics bounded and closed at a 320px form width", () => {
    const malformed = `{"message":"subscription expired ${"x".repeat(600)}","session_id":"private-session`;
    const { container } = render(<div style={{ width: 320 }}>
      <ProviderAvailabilityAlerts
        engines={[engine("claude", {
          intakeReady: false,
          reachability: "degraded",
          availabilityDetail: malformed,
        })]}
        testPending={false}
        onTestAccess={vi.fn()}
      />
    </div>);

    expect(screen.getByText(
      "Claude access is unavailable. Check the Claude subscription and Claude Code sign-in, then test access.",
    )).toBeTruthy();
    const disclosure = container.querySelector("details");
    expect(disclosure?.hasAttribute("open")).toBe(false);
    const diagnostic = screen.getByTestId("provider-diagnostic-claude").textContent ?? "";
    expect(diagnostic.length).toBeLessThanOrEqual(MAX_PROVIDER_DIAGNOSTIC_CHARACTERS);
    expect(diagnostic).not.toContain("private-session");
  });

  it("preserves provider association when every enabled provider has failed", () => {
    render(<ProviderAvailabilityAlerts
      engines={[
        engine("claude", { intakeReady: false, reachability: "degraded", availabilityDetail: "subscription expired" }),
        engine("codex", { authentication: "unauthenticated", intakeReady: false, reachability: "degraded", authDetail: "login required" }),
      ]}
      testPending={false}
      onTestAccess={vi.fn()}
    />);

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(within(alerts[0]!).getByText(/Claude access is unavailable/)).toBeTruthy();
    expect(within(alerts[0]!).getByRole("button", { name: "Test Claude access" })).toBeTruthy();
    expect(within(alerts[1]!).getByText(/Codex is not signed in/)).toBeTruthy();
    expect(within(alerts[1]!).queryByRole("button")).toBeNull();
  });
});
