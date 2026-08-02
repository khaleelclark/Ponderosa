import { describe, expect, it } from "vitest";
import { displayProjectPath } from "../src/project-path-display.js";

const uuid = "05a0f7df-21cd-4fe1-8c5b-814f460684ab";

describe("displayProjectPath", () => {
  it("hides generated Linux and macOS private workspaces", () => {
    expect(displayProjectPath({
      hostPath: `/home/phoenix/.ponderosa/workspaces/project-${uuid}`,
      homePath: "/home/phoenix",
      managedWorkspacesRoot: "/home/phoenix/.ponderosa/workspaces",
    })).toBe("Private workspace");
    expect(displayProjectPath({
      hostPath: `/Users/patmi/Library/Application Support/Ponderosa/workspaces/project-${uuid}`,
      homePath: "/Users/patmi",
      managedWorkspacesRoot: "/Users/patmi/Library/Application Support/Ponderosa/workspaces",
    })).toBe("Private workspace");
  });

  it("humanizes folders below the current home and preserves outside paths", () => {
    expect(displayProjectPath({
      hostPath: "/home/phoenix/mutant",
      homePath: "/home/phoenix",
      managedWorkspacesRoot: "/var/lib/ponderosa/workspaces",
    })).toBe("~/mutant");
    expect(displayProjectPath({
      hostPath: "/opt/shared/project",
      homePath: "/home/phoenix",
      managedWorkspacesRoot: "/var/lib/ponderosa/workspaces",
    })).toBe("/opt/shared/project");
  });

  it("uses native Windows separators and case-insensitive home matching", () => {
    expect(displayProjectPath({
      hostPath: "C:\\Users\\Pat\\projects\\demo",
      homePath: "c:\\users\\pat",
      managedWorkspacesRoot: "C:\\ProgramData\\Ponderosa\\workspaces",
    })).toBe("~\\projects\\demo");
    expect(displayProjectPath({
      hostPath: `C:\\Users\\Pat\\AppData\\Local\\Ponderosa\\workspaces\\project-${uuid}`,
      homePath: "C:\\Users\\Pat",
      managedWorkspacesRoot: "C:\\Users\\Pat\\AppData\\Local\\Ponderosa\\workspaces",
    })).toBe("Private workspace");
  });

  it("ignores trailing separators when comparing homes and managed workspaces", () => {
    expect(displayProjectPath({
      hostPath: "/home/phoenix/",
      homePath: "/home/phoenix",
      managedWorkspacesRoot: "/var/lib/ponderosa/workspaces/",
    })).toBe("~");
    expect(displayProjectPath({
      hostPath: "/home/phoenix/projects/demo/",
      homePath: "/home/phoenix/",
      managedWorkspacesRoot: "/var/lib/ponderosa/workspaces",
    })).toBe("~/projects/demo");
    expect(displayProjectPath({
      hostPath: `/home/phoenix/.ponderosa/workspaces/project-${uuid}/`,
      homePath: "/home/phoenix/",
      managedWorkspacesRoot: "/home/phoenix/.ponderosa/workspaces/",
    })).toBe("Private workspace");
    expect(displayProjectPath({
      hostPath: "C:\\Users\\Pat\\",
      homePath: "c:\\users\\pat",
      managedWorkspacesRoot: "C:\\ProgramData\\Ponderosa\\workspaces\\",
    })).toBe("~");
    expect(displayProjectPath({
      hostPath: `C:\\Users\\Pat\\AppData\\Local\\Ponderosa\\workspaces\\project-${uuid}\\`,
      homePath: "C:\\Users\\Pat\\",
      managedWorkspacesRoot: "C:\\Users\\Pat\\AppData\\Local\\Ponderosa\\workspaces\\",
    })).toBe("Private workspace");
  });

  it("humanizes valid home children whose names begin with two dots", () => {
    expect(displayProjectPath({
      hostPath: "/home/phoenix/..project",
      homePath: "/home/phoenix",
      managedWorkspacesRoot: "/var/lib/ponderosa/workspaces",
    })).toBe("~/..project");
    expect(displayProjectPath({
      hostPath: "C:\\Users\\Pat\\..project",
      homePath: "C:\\Users\\Pat",
      managedWorkspacesRoot: "C:\\ProgramData\\Ponderosa\\workspaces",
    })).toBe("~\\..project");
  });

  it("does not hide named managed folders", () => {
    expect(displayProjectPath({
      hostPath: "/home/phoenix/.ponderosa/workspaces/client-demo",
      homePath: "/home/phoenix",
      managedWorkspacesRoot: "/home/phoenix/.ponderosa/workspaces",
    })).toBe("~/.ponderosa/workspaces/client-demo");
  });
});
