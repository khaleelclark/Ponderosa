import { describe, expect, it } from "vitest";
import type { ProjectDto } from "@ponderosa/core";
import { createProjectRequest, nextProjectAfterDelete, projectCreationDisabled } from "../src/projectLifecycle";

describe("project lifecycle UI", () => {
  it("requires an engine and validated host-folder choice", () => {
    expect(projectCreationDisabled({ label: "Demo", mode: "existing", existingPath: "", newFolderName: "", defaultEngine: "codex", pending: false })).toBe(true);
    expect(projectCreationDisabled({ label: "Demo", mode: "existing", existingPath: "/repo", newFolderName: "", defaultEngine: "", pending: false })).toBe(true);
    expect(createProjectRequest({ label: " Demo ", mode: "existing", existingPath: " /repo ", newFolderName: "", defaultEngine: "codex" })).toEqual({ label: "Demo", hostPath: "/repo", defaultEngine: "codex" });
    expect(createProjectRequest({ label: "Demo", mode: "create", existingPath: "", newFolderName: " fresh ", defaultEngine: "claude" })).toEqual({ label: "Demo", createFolderName: "fresh", defaultEngine: "claude" });
  });

  it("navigates to a surviving project after confirmed deletion", () => {
    const base = { hostPath: "/repo", createdAt: "2026-07-12T00:00:00.000Z", lastUsedAt: "2026-07-12T00:00:00.000Z", defaultEngine: "codex" as const };
    const projects: ProjectDto[] = [{ ...base, id: "a", label: "A" }, { ...base, id: "b", label: "B" }];
    expect(nextProjectAfterDelete(projects, "a")?.id).toBe("b");
    expect(nextProjectAfterDelete([projects[0]!], "a")).toBeUndefined();
  });
});
