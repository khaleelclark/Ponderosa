import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EngineDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROVIDER_DIAGNOSTIC_CHARACTERS,
  providerAvailabilityDiagnostic,
  providerAvailabilityMessage,
} from "../providerAvailability";
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
      "Claude access is unavailable. Review the restricted server logs, then retry the provider operation.",
    )).toBeTruthy();
    const disclosure = container.querySelector("details");
    expect(disclosure?.hasAttribute("open")).toBe(false);
    const diagnostic = screen.getByTestId("provider-diagnostic-claude").textContent ?? "";
    expect(diagnostic.length).toBeLessThanOrEqual(MAX_PROVIDER_DIAGNOSTIC_CHARACTERS);
    expect(diagnostic).not.toContain("private-session");
  });

  it("maps nested stringified diagnostics to a generic code-owned message", () => {
    const nested = JSON.stringify({
      type: "result",
      error: JSON.stringify({
        message: "Claude subscription expired",
        session_id: "private-nested-session",
        access_token: "private-nested-token",
      }),
    });
    render(<ProviderAvailabilityAlerts
      engines={[engine("claude", {
        intakeReady: false,
        reachability: "degraded",
        availabilityDetail: nested,
      })]}
      testPending={false}
      onTestAccess={vi.fn()}
    />);

    expect(screen.getByTestId("provider-diagnostic-claude").textContent).toBe("Provider execution failed.");
    expect(document.body.textContent).not.toContain("private-nested-session");
    expect(document.body.textContent).not.toContain("private-nested-token");
  });

  it("fails closed for secret-bearing, malformed, and over-deep fallback detail", () => {
    const secretEnvelope = JSON.stringify({
      error: JSON.stringify({
        message: JSON.stringify({ session_id: "private-session", access_token: "private-token" }),
      }),
    });
    expect(providerAvailabilityDiagnostic(secretEnvelope)).toBe("Provider execution failed.");
    expect(providerAvailabilityDiagnostic('{"message":"refresh_token: private-token","error":')).toBe("Provider execution failed.");

    let deep: unknown = { message: "must-not-escape-depth-limit" };
    for (let index = 0; index < 8; index += 1) deep = { error: JSON.stringify(deep) };
    expect(providerAvailabilityDiagnostic(JSON.stringify(deep))).toBe("Provider execution failed.");
    expect(providerAvailabilityDiagnostic("x".repeat(64 * 1024 + 1))).toBe("Provider execution failed.");
  });

  it("rejects client-side credential paths, tokens, encoded JSON, and obfuscated secrets", () => {
    const adversarial = [
      "failed reading /home/phoenix/.config/gh/hosts.yml",
      "failed reading /tmp",
      String.raw`failed reading C:\Users\Patrick\.aws\credentials`,
      String.raw`failed reading C:\auth.json`,
      String.raw`failed reading .aws\credentials`,
      String.raw`failed reading \u002fhome\u002fphoenix\u002f.codex\u002fauth.json`,
      "password=hunter2",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "AKIAABCDEFGHIJKLMNOP",
      "oauth callback code=private-code",
      "-----BEGIN PRIVATE KEY----- private-key-material",
      "eyJzZXNzaW9uX2lkIjoicHJpdmF0ZSJ9",
      "Zk9xR1p4dHFzUDBTQnNLWkQ5Q3h5ZkF0RmhjWmZ2",
      "access\u200b_token=private-token",
      String.raw`pa\u0073sword=hunter2`,
      String.raw`password\u003dhunter2`,
      String.raw`password%3Dhunter2`,
      "pass\u2063word=hunter2",
      "pass\ufe0fword=hunter2",
      "pa\u0301ssword=hunter2",
      "SECRET_KEY=hunter2",
      "/root/.aws/credentials",
      "/etc/shadow",
      "/auth.json",
      "$HOME/.aws/credentials",
      "${HOME}/.codex/auth.json",
      "W3sicGFzc3dvcmQiOiJ4In1d",
    ];
    for (const detail of adversarial) {
      const diagnostic = providerAvailabilityDiagnostic(detail);
      expect(diagnostic, detail).toBe("Provider execution failed.");
      expect(diagnostic, detail).not.toContain(detail);
    }
    expect(providerAvailabilityDiagnostic("connection reset by peer")).toBe("Provider is temporarily unavailable.");
  });

  it("uses category-accurate remediation for provider degradation", () => {
    expect(providerAvailabilityMessage(engine("claude", {
      intakeReady: false,
      reachability: "degraded",
      availabilityDetail: "subscription expired",
    }))).toContain("provider subscription and sign-in");
    expect(providerAvailabilityMessage(engine("claude", {
      intakeReady: false,
      reachability: "degraded",
      availabilityDetail: "subscription inactive",
    }))).toContain("provider subscription and sign-in");
    expect(providerAvailabilityMessage(engine("codex", {
      intakeReady: false,
      reachability: "degraded",
      availabilityDetail: "usage limit reached; limit resets soon",
    }))).toContain("provider usage limit to reset");
    expect(providerAvailabilityMessage(engine("claude", {
      intakeReady: false,
      reachability: "degraded",
      availabilityDetail: "selected model is at capacity",
    }))).toContain("provider capacity is available");

    const unknown = providerAvailabilityMessage(engine("claude", {
      intakeReady: false,
      reachability: "degraded",
      availabilityDetail: "connection reset by peer",
    }));
    expect(unknown).toContain("Retry when the provider is available");
    expect(unknown).not.toMatch(/subscription|sign-in/iu);
  });

  it("uses the structured category for both diagnostic summary and remediation", () => {
    const marker = "STRUCTURED_CATEGORY_RAW_MARKER_74b2";
    render(<ProviderAvailabilityAlerts
      engines={[engine("claude", {
        intakeReady: false,
        reachability: "degraded",
        availabilityCategory: "authentication",
        availabilityDetail: `rate limit reached ${marker}`,
      })]}
      testPending={false}
      onTestAccess={vi.fn()}
    />);

    expect(screen.getByText(
      "Claude access is unavailable. Check the provider subscription and sign-in, then retry.",
    )).toBeTruthy();
    expect(screen.getByTestId("provider-diagnostic-claude").textContent).toBe(
      "Provider authentication was rejected.",
    );
    expect(document.body.textContent).not.toContain(marker);
    expect(document.body.textContent).not.toContain("rate limit reached");
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
