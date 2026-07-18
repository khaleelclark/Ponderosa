import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const agentDetail = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");
const runtimeSelector = readFileSync(new URL("../src/components/ComposerRuntimeSelector.tsx", import.meta.url), "utf8");

describe("composer surface ownership", () => {
  it("keeps the full shared composer in direct Agent chat with an explicit running-agent queue", () => {
    expect(agentDetail).toContain("controls={agentRuntimeControls}");
    expect(agentDetail).toContain('onQueue={runtimeActivity ? submitAgentMessage("queue") : undefined}');
    expect(agentDetail).toContain("agentResponding={Boolean(runtimeActivity)}");
    expect(agentDetail).toContain('{tab === "chat" ? <Box');
    expect(agentDetail).toContain('<Box sx={{ minWidth: 0 }}>\n        <BrowserPanel');
  });

  it("keeps Team chat read-only", () => {
    expect(conversation).toContain("Team chat is a read-only audit trail of agent-to-agent coordination.");
    expect(conversation).not.toContain("TeamCollaborationComposer");
    expect(conversation).not.toContain("api.sendCollaborationMessage");
  });

  it("keeps managed-agent lineage visible beside the agent title", () => {
    expect(agentDetail).toContain('const lineageAgent = spawningAgent ?? organizationalParent;');
    expect(agentDetail).toContain('const lineageLabel = detail.agent.spawnedByAgentId ? "Created by" : "Reports to";');
    expect(agentDetail).toContain('{lineageAgentId ? <Typography variant="caption"');
  });

  it("floats the shared composer above the viewport edge", () => {
    expect(panes).toContain('width: { xs: "calc(100% - 16px)", sm: "calc(100% - 32px)", md: "min(1180px, calc(100% - 48px))", xl: "min(1240px, calc(100% - 64px))" }');
    expect(panes).toContain("mb: { xs: 1, sm: 1.5 }");
    expect(panes).not.toContain('position: "sticky",\n        bottom: 0');
  });

  it("uses one Codex-style runtime control without a speed setting", () => {
    expect(conversation).toContain("<ComposerRuntimeSelector");
    expect(agentDetail).toContain("<ComposerRuntimeSelector");
    expect(runtimeSelector).toContain('type RuntimeSection = "engine" | "model" | "effort"');
    expect(runtimeSelector).toContain('placement="top-end"');
    expect(runtimeSelector).not.toContain('label: "Speed"');
  });

  it("keeps the active-turn actions explicit and presents chat as an open transcript", () => {
    expect(panes).toContain('aria-label="Steer active response"');
    expect(panes).toContain('showTimestamp={fromUser}');
    expect(conversation).toContain('justifyContent: fromManager ? "flex-end" : "flex-start"');
    expect(conversation).toContain('width: fromManager ? "fit-content" : "min(100%, 960px)"');
    expect(conversation).toContain('maxWidth: fromManager ? "min(78%, 780px)" : "100%"');
    expect(conversation).toContain('showTimestamp={fromManager}');
  });
});
