import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { queryKeys } from "../../queryKeys";
import { ActionGroupRow } from "./ActivityRows";

afterEach(cleanup);

describe("ActivityRows diff presentation", () => {
  it("keeps canonical activity identity while reconstructing raw provider diff headers", () => {
    const rawPath = "/srv/project/..\\secret.ts";
    const artifactId = "agent-1:a:7:0";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.projectArtifacts.agentContent("agent-1", artifactId), {
      id: artifactId,
      agentId: "agent-1",
      kind: "diff",
      path: "artifacts/secret.diff",
      sourcePath: rawPath,
      summary: `edit ${rawPath}`,
      createdAt: "2026-08-14T00:00:00.000Z",
      contentType: "diff",
      content: [
        "--- /home/phoenix/private/old.ts",
        "+++ C:\\Users\\patrick\\private.ts",
        "@@ -1 +1 @@ /home/phoenix/private",
        "-old",
        "+new",
      ].join("\n"),
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ActionGroupRow
          entries={[{
            id: "activity-7",
            seq: 7,
            createdAt: "2026-08-14T00:00:00.000Z",
            kind: "file",
            agentId: "agent-1",
            path: rawPath,
            changeKind: "edit",
            artifactId,
          }]}
          focusId="activity-7"
          projectRoot="/srv/project"
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "Edited secret.ts" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByLabelText("Unified diff").textContent).toContain("diff --git a/secret.ts b/secret.ts");
    expect(container.textContent).not.toContain("/home/phoenix");
    expect(container.textContent).not.toContain("C:\\Users");
    expect(container.innerHTML).not.toContain(rawPath);
  });

  it.each([
    ["rename-from", "rename from /home/phoenix/private/old.ts"],
    ["rename-to", "rename to C:\\Users\\patrick\\private.ts"],
    ["copy-from", "copy from \\\\server\\share\\private.ts"],
    ["copy-to", "copy to /home/phoenix/private/copied.ts"],
    ["binary", "Binary files /home/phoenix/private/old.bin and \\\\server\\share\\private.bin differ"],
    ["context", "*** /home/phoenix/private/old.ts\t2026-08-14"],
  ])("fails a create-mode %s header closed in inline Activity preview", (_name, rawDiff) => {
    const rawPath = "/srv/project/src/public.ts";
    const artifactId = `agent-1:a:${_name}:0`;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.projectArtifacts.agentContent("agent-1", artifactId), {
      id: artifactId,
      agentId: "agent-1",
      kind: "diff",
      path: `artifacts/create-${_name}.diff`,
      sourcePath: rawPath,
      summary: `create ${rawPath}`,
      createdAt: "2026-08-14T00:00:00.000Z",
      contentType: "diff",
      content: rawDiff,
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ActionGroupRow
          entries={[{
            id: `activity-${_name}`,
            seq: 7,
            createdAt: "2026-08-14T00:00:00.000Z",
            kind: "file",
            agentId: "agent-1",
            path: rawPath,
            changeKind: "create",
            artifactId,
          }]}
          focusId={`activity-${_name}`}
          projectRoot="/srv/project"
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.queryByLabelText("Unified diff")).toBeNull();
    expect(container.textContent).not.toContain("/home/phoenix");
    expect(container.textContent).not.toContain("C:\\Users");
    expect(container.innerHTML).not.toContain("server\\share");
  });
});
