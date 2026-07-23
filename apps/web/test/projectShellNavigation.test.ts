import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectShellSource = readFileSync(new URL("../src/components/ProjectShell.tsx", import.meta.url), "utf8");
const agentDetailSource = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");

describe("agent detail navigation", () => {
  it("does not expose obsolete back-to-agents UI or callback wiring", () => {
    expect(agentDetailSource).not.toContain("ArrowBackIcon");
    expect(agentDetailSource).not.toContain("Back to agents");
    expect(agentDetailSource).not.toContain("onBack");
    expect(projectShellSource).not.toContain("agentBackRoute");
    expect(projectShellSource).not.toContain("onBack=");
  });

  it("does not hydrate every Agent's full history from the Project shell", () => {
    expect(projectShellSource).not.toContain("useQueries");
    expect(projectShellSource).not.toContain("detailByAgentId");
    expect(projectShellSource).not.toContain("api.getAgent(");
  });

  it("opens focused reviews in user-managed Ponderosa tabs", () => {
    expect(projectShellSource).toContain("onOpenReviewInNewTab");
    expect(projectShellSource).toContain('openInNewTab?.({ kind: "review", projectId, agentId: route.agentId');
    expect(projectShellSource).toContain('onOpenInNewTab={(path) => openInNewTab?.({ kind: "review", projectId, agentId: route.agentId, path })}');
  });
});
