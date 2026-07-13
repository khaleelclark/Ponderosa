import { describe, expect, it } from "vitest";
import type { ProjectDto } from "@ponderosa/core";
import { createProjectRequest, nextProjectAfterDelete, projectCreationDisabled } from "../src/projectLifecycle";

describe("project lifecycle UI", () => {
  it("keeps working-folder selection optional while validating explicit choices", () => {
    expect(projectCreationDisabled({ label: "Demo", mode: "automatic", existingPath: "", newFolderName: "", pending: false })).toBe(false);
    expect(createProjectRequest({ label: " Demo ", mode: "automatic", existingPath: "", newFolderName: "" })).toEqual({ label: "Demo" });
    expect(projectCreationDisabled({ label: "Demo", mode: "existing", existingPath: "", newFolderName: "", pending: false })).toBe(true);
    expect(createProjectRequest({ label: "Demo", mode: "existing", existingPath: " /repo ", newFolderName: "" })).toEqual({ label: "Demo", hostPath: "/repo" });
    expect(createProjectRequest({ label: "Demo", mode: "create", existingPath: "", newFolderName: " fresh " })).toEqual({ label: "Demo", createFolderName: "fresh" });
  });

  it("navigates to a surviving project after confirmed deletion", () => {
    const base = { hostPath: "/repo", createdAt: "2026-07-12T00:00:00.000Z" };
    const projects: ProjectDto[] = [{ ...base, id: "a", label: "A" }, { ...base, id: "b", label: "B" }];
    expect(nextProjectAfterDelete(projects, "a")?.id).toBe("b");
    expect(nextProjectAfterDelete([projects[0]!], "a")).toBeUndefined();
  });
});
