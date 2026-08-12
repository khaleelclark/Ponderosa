import type {
  WorkspacePreferencesDto,
  WorkspaceResourceRecencyDto,
} from "@ponderosa/core";
import { describe, expect, test } from "vitest";
import {
  boundWorkspaceResourceRecency,
  workspaceResourceRecencyTime,
} from "./workspaceRecency";
import { workspaceResourceStarsChanged } from "./resourcePreferences";

function preferences(): WorkspacePreferencesDto {
  return {
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
    starredResourceIds: ["agent:old-star"],
    starredProjectIds: ["legacy-star"],
    sidebarCollapsed: false,
    sidebarWidth: 288,
    notifications: { directResponses: true, broadcasts: true },
    fontFamily: "inter",
    providerAvailability: {},
    engineDefaults: {},
    claudeModelOptions: [],
    globalInstructions: "",
    maxConcurrentAgentRuns: 8,
    contextRolloverEnabled: false,
    contextRolloverTokens: 150_000,
    contextRolloverWindowFraction: 0.7,
    onboardingCompletedAt: null,
    profile: { displayName: "User", handle: "operator", avatarId: "default-user" },
    updatedAt: new Date(0).toISOString(),
  };
}

describe("workspace recency cache budget", () => {
  test("retains stars outside the bounded recent window", () => {
    const resources: WorkspaceResourceRecencyDto[] = [
      ...Array.from({ length: 5 }, (_, index): WorkspaceResourceRecencyDto => ({
        resourceKey: `agent:${index}`,
        kind: "agent" as const,
        resourceId: String(index),
        lastUsedAt: new Date(10_000 - index).toISOString(),
      })),
      {
        resourceKey: "agent:old-star",
        kind: "agent",
        resourceId: "old-star",
        lastUsedAt: new Date(1).toISOString(),
      },
      {
        resourceKey: "project:legacy-star",
        kind: "project",
        resourceId: "legacy-star",
        lastUsedAt: new Date(0).toISOString(),
      },
    ];

    expect(boundWorkspaceResourceRecency(resources, preferences(), 3).map(
      resource => resource.resourceKey,
    )).toEqual([
      "agent:0",
      "agent:1",
      "agent:2",
      "agent:old-star",
      "project:legacy-star",
    ]);
  });

  test("does not let omitted old entries jump ahead through fallback timestamps", () => {
    const resources: WorkspaceResourceRecencyDto[] = [{
      resourceKey: "agent:recent",
      kind: "agent",
      resourceId: "recent",
      lastUsedAt: "2026-08-12T08:00:00.000Z",
    }];
    expect(workspaceResourceRecencyTime(
      { resources, truncated: true },
      "agent:omitted",
      "2026-08-12T09:00:00.000Z",
    )).toBe("1970-01-01T00:00:00.000Z");
    expect(workspaceResourceRecencyTime(
      { resources },
      "agent:never-used",
      "2026-08-12T09:00:00.000Z",
    )).toBe("2026-08-12T09:00:00.000Z");
  });

  test("detects star changes that require a bounded projection refresh", () => {
    const previous = preferences();
    expect(workspaceResourceStarsChanged(previous, { ...previous })).toBe(false);
    expect(workspaceResourceStarsChanged(previous, {
      ...previous,
      starredResourceIds: [...(previous.starredResourceIds ?? []), "agent:new-star"],
    })).toBe(true);
    expect(workspaceResourceStarsChanged(previous, {
      ...previous,
      starredProjectIds: ["different-legacy-star"],
    })).toBe(true);
  });
});
