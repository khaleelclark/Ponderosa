import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ResponseFileActivityDto } from "@ponderosa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseFileActivity } from "./ResponseFileActivity";

afterEach(cleanup);

function file(path: string): ResponseFileActivityDto {
  return {
    path,
    kind: "edit",
    status: "completed",
    sourceSeq: 7,
    previewable: true,
    additions: 1,
    deletions: 1,
  };
}

describe("ResponseFileActivity path presentation", () => {
  it("shows a safe Project-relative path while preserving the raw authority value for navigation", () => {
    const rawPath = "/srv/project/src/index.ts";
    const item = file(rawPath);
    const onOpenFile = vi.fn();

    const { container } = render(
      <ResponseFileActivity
        files={[item]}
        projectRoot="/srv/project"
        onOpenFile={onOpenFile}
      />,
    );

    const open = screen.getByRole("button", { name: "Open focused diff for src/index.ts" });
    expect(container.textContent).toContain("src/index.ts");
    expect(container.innerHTML).not.toContain(rawPath);
    fireEvent.click(open);
    expect(onOpenFile).toHaveBeenCalledWith(item);
  });

  it.each([
    ["external host path", "/home/phoenix/private/secret.ts", "secret.ts"],
    ["backslash traversal", "/srv/project/..\\secret.ts", "secret.ts"],
    ["Windows-looking filename", "/srv/project/C:\\Users\\patrick\\private.ts", "private.ts"],
    ["UNC-looking filename", "/srv/project/\\\\server\\share\\private.ts", "private.ts"],
  ])("keeps a raw %s out of visible and ARIA output", (_name, rawPath, displayPath) => {
    const { container } = render(
      <ResponseFileActivity
        files={[file(rawPath)]}
        projectRoot="/srv/project"
        onOpenFile={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: `Open focused diff for ${displayPath}` })).toBeTruthy();
    expect(container.textContent).toContain(displayPath);
    expect(container.textContent).not.toContain(rawPath);
    expect(container.innerHTML).not.toContain(rawPath);
  });
});
