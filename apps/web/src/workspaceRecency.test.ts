import type {
  WorkspacePreferencesDto,
  WorkspaceResourceRecencyDto,
} from "@ponderosa/core";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  boundWorkspaceResourceRecency,
  markWorkspaceResourceUsed,
  workspaceResourceRecencyTime,
} from "./workspaceRecency";
import { workspaceResourceStarsChanged } from "./resourcePreferences";
import { api } from "./api";

afterEach(() => vi.restoreAllMocks());

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

  test("does not let a recent star consume the ordinary budget", () => {
    const currentPreferences = preferences();
    currentPreferences.starredResourceIds = ["agent:0", "agent:old-star"];
    const resources = [
      ...Array.from({ length: 5 }, (_, index): WorkspaceResourceRecencyDto => ({
        resourceKey: `agent:${index}`,
        kind: "agent",
        resourceId: String(index),
        lastUsedAt: new Date(10_000 - index).toISOString(),
      })),
      {
        resourceKey: "agent:old-star" as const,
        kind: "agent" as const,
        resourceId: "old-star",
        lastUsedAt: new Date(1).toISOString(),
      },
    ];

    expect(boundWorkspaceResourceRecency(resources, currentPreferences, 3).map(
      resource => resource.resourceKey,
    )).toEqual([
      "agent:0",
      "agent:1",
      "agent:2",
      "agent:3",
      "agent:old-star",
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

  test("invalidates the bounded projection when an optimistic use write fails", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["workspace-preferences"], preferences());
    queryClient.setQueryData(["workspace-resource-recency"], {
      resources: [],
      truncated: true,
    });
    vi.spyOn(api, "markWorkspaceResourceUsed").mockRejectedValueOnce(
      new Error("offline"),
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    markWorkspaceResourceUsed(queryClient, "agent", "optimistic");
    expect(queryClient.getQueryData<{ resources: WorkspaceResourceRecencyDto[] }>(
      ["workspace-resource-recency"],
    )?.resources[0]?.resourceKey).toBe("agent:optimistic");
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["workspace-resource-recency"],
    }));
  });

  test("marks an optimistic 101st ordinary resource as truncated", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["workspace-preferences"], preferences());
    queryClient.setQueryData(["workspace-resource-recency"], {
      resources: Array.from(
        { length: 100 },
        (_, index): WorkspaceResourceRecencyDto => ({
          resourceKey: `agent:${index}`,
          kind: "agent",
          resourceId: String(index),
          lastUsedAt: new Date(10_000 - index).toISOString(),
        }),
      ),
    });
    vi.spyOn(api, "markWorkspaceResourceUsed").mockReturnValueOnce(
      new Promise(() => undefined),
    );

    markWorkspaceResourceUsed(queryClient, "agent", "new");

    const result = queryClient.getQueryData<{
      resources: WorkspaceResourceRecencyDto[];
      truncated?: boolean;
    }>(["workspace-resource-recency"]);
    expect(result?.resources).toHaveLength(100);
    expect(result?.resources[0]?.resourceKey).toBe("agent:new");
    expect(result?.truncated).toBe(true);
  });
});
