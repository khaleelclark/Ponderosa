import type { WorkspacePreferencesDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_AGENT_INSTRUCTIONS_HELPER_TEXT,
  GLOBAL_AGENT_INSTRUCTIONS_LABEL,
  WorkspaceSettingsView,
} from "../src/components/WorkspaceSettingsView";

const preferences = {
  projectSort: "last_used",
  projectOrder: [],
  homeSort: "last_used",
  homeOrder: [],
  chatSort: "last_used",
  chatOrder: [],
  agentSort: "last_used",
  agentOrder: [],
  triggerSort: "last_used",
  triggerOrder: [],
  starredProjectIds: [],
  starredResourceIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 288,
  notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false },
  fontFamily: "inter",
  providerAvailability: {},
  globalInstructions: "Prefer concise answers.",
  maxConcurrentAgentRuns: 8,
  onboardingCompletedAt: "2026-07-23T00:00:00.000Z",
  profile: { displayName: "Patrick", handle: "pto", avatarId: "default-user" },
  updatedAt: "2026-07-23T00:00:00.000Z",
} as WorkspacePreferencesDto;

describe("global Agent instructions Settings copy", () => {
  it("makes scope, precedence, session timing, and routing limits explicit", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <WorkspaceSettingsView
          preferences={preferences}
          engines={[]}
          colorMode="light"
          onToggleColorMode={() => undefined}
          onPreferences={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(GLOBAL_AGENT_INSTRUCTIONS_LABEL).toBe("Global Agent Instructions");
    expect(GLOBAL_AGENT_INSTRUCTIONS_HELPER_TEXT).toContain("every Agent on the next fresh provider session");
    expect(GLOBAL_AGENT_INSTRUCTIONS_HELPER_TEXT).toContain("Project and Agent instructions follow it");
    expect(GLOBAL_AGENT_INSTRUCTIONS_HELPER_TEXT).toContain("preferred models");
    expect(GLOBAL_AGENT_INSTRUCTIONS_HELPER_TEXT).toContain("guidance rather than guaranteed structural routing");
    expect(html).toContain(GLOBAL_AGENT_INSTRUCTIONS_LABEL);
    expect(html).toContain(GLOBAL_AGENT_INSTRUCTIONS_HELPER_TEXT);
  });
});
