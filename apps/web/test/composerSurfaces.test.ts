import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const agentDetail = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");

describe("composer surface ownership", () => {
  it("keeps the full shared composer in direct Agent chat with an explicit running-agent queue", () => {
    expect(agentDetail).toContain("controls={agentRuntimeControls}");
    expect(agentDetail).toContain('onQueue={runtimeActivity ? submitAgentMessage("queue") : undefined}');
    expect(agentDetail).toContain("agentResponding={Boolean(runtimeActivity)}");
    expect(agentDetail).toContain('{tab === "chat" ? <Box');
    expect(agentDetail).toContain('<Box sx={{ minWidth: 0 }}>\n        <BrowserPanel');
  });

  it("keeps Team chat read-only", () => {
    expect(conversation).toContain("Team chat is read-only. Agent collaboration appears here; message an agent from its Agent chat.");
    expect(conversation).not.toContain("TeamCollaborationComposer");
    expect(conversation).not.toContain("api.sendCollaborationMessage");
  });

  it("floats the shared composer above the viewport edge", () => {
    expect(panes).toContain('width: { xs: "calc(100% - 16px)", sm: "min(780px, calc(100% - 24px))" }');
    expect(panes).toContain("mb: { xs: 1, sm: 1.5 }");
    expect(panes).not.toContain('position: "sticky",\n        bottom: 0');
  });
});
