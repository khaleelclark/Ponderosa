import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../src/api";
import { createPonderosaTheme } from "../src/theme";
import { WorkspaceReviewPane } from "../src/components/files/WorkspaceReviewPane";
import { ProviderActivitySettingsSection } from "../src/components/WorkspaceResourceViews";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { buildMarkdownTranscript, downloadMarkdownTranscript } from "../src/chatTranscript";
import { ConversationWorkspaceFiles } from "../src/components/files/ConversationWorkspaceFiles";
import { FilePreview } from "../src/components/filePreview/FilePreview";
import { AgentWorkInspector } from "../src/components/AgentWorkInspector";
import { OperatorProfileEditor, useOperatorProfileForm } from "../src/components/OperatorProfileEditor";
import { MessageDeliveryStatus } from "../src/components/MessageDeliveryStatus";
import { AgentDetailSettingsController } from "../src/components/AgentDetailSettingsController";
import { useState } from "react";

const params = new URLSearchParams(location.search);
const files = Array.from({ length: 75 }, (_, index) => ({ path: `src/file-${index}.ts`, kind: "edit" as const,
  lastSeq: index + 1, lastChangedAt: "2026-09-29T12:00:00Z", executionCount: 1, executionIds: ["selected-run"],
  diffAvailable: true, provenanceTruncated: false, diff: `--- a/src/file-${index}.ts\n+++ b/src/file-${index}.ts\n@@ -1 +1${index === 74 ? ",2" : ""} @@\n-old-${index}\n+new-${index}\n${index === 74 ? `+${"long_line".repeat(100)}\n` : ""}` }));
api.getResponseFileReview = async () => ({ executionId: "selected-run", files, truncated: false });
api.getWorkspaceStatus = async () => ({ isGitRepository: false, workingCopy: { mode: "shared", rootPath: "/test" }, changes: [] }) as never;
api.listAgents = async () => Array.from({ length: 695 }, (_, index) => ({ id: `agent-${index}`, title: `Reviewer ${index}`, handle: `reviewer-${index}`, projectId: "project", conversationId: "chat", activeEngine: "codex" })) as never;
api.listConversations = async () => [{ id: "chat", projectId: "project", title: "Marketing", archived: false }] as never;
api.getTokenUsage = async scope => ({ scope, finalizedRuns: 0, reportedRuns: 0, providerRequests: 0, durationMs: 0, metricAvailability: {}, breakdown: [], wakeCauses: [] }) as never;
const project = { id: "project", label: "Working folder", hostPath: "/test", defaultEngine: "codex" } as const;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const items = [
  { id: "activation:earlier", recordId: "earlier", kind: "activation", state: "consumed", title: "Successful earlier wake-up", summary: "The provider started successfully.", referenceIds: ["failed-request"] },
  { id: "request:failed-request", recordId: "failed-request", kind: "request", state: "failed", title: "Failed assignment", summary: "The assigned task could not finish because the required file was missing.", referenceIds: [] },
].map(item => ({ ...item, agentIds: [], relatedItemIds: [], details: [], createdAt: "2026-09-29T12:00:00Z", updatedAt: "2026-09-29T12:00:00Z" }));
api.getAgentWork = (async () => ({ projectId: "project", generatedAt: "2026-09-29T12:00:00Z", agents: [], items, traces: [{ id: "workflow", title: "Assignment workflow", summary: "Assignment failed", state: "attention", agentIds: [], itemIds: items.map(item => item.id), createdAt: "2026-09-29T12:00:00Z", updatedAt: "2026-09-29T12:00:00Z" }] })) as typeof api.getAgentWork;
function ProfileFixture() {
  const form = useOperatorProfileForm({ displayName: "Tester", handle: "tester", avatarId: "default-user" });
  return <><OperatorProfileEditor form={form} avatarSize={48} nameLabel="Display name" handleHelperText="Use # for Agent/user mentions and @ for files." pictureLabelId="profile-avatar" /><button disabled={!form.valid}>Save profile</button></>;
}
function FreshSessionFixture() {
  const [agentId, setAgentId] = useState("agent-one");
  const noop = () => {};
  api.getWorkspacePreferences = async () => ({ notificationScopes: {} }) as never;
  api.listBrowserProfiles = async () => [];
  api.compactSession = (() => {
    document.body.dataset.freshCalls = String(Number(document.body.dataset.freshCalls ?? 0) + 1);
    return new Promise((resolve, reject) => Object.assign(window, {
      settleFreshSession: (failure: boolean) => failure ? reject(new Error("Provider could not schedule the fresh session. Try again.")) : resolve({}),
    }));
  }) as typeof api.compactSession;
  const agent = { id: agentId, projectId: "project", title: "Reviewer", activeEngine: "codex",
    managementPermissions: {}, workingCopy: { mode: "shared", state: "ready", rootPath: "/test" } } as never;
  return <MutationNotificationProvider><button onClick={() => setAgentId("agent-two")}>Switch Agent</button>
    <AgentDetailSettingsController agent={agent} engines={[]} settingsEngine="codex" settingsModel="" settingsEffort=""
      settingsModels={[]} settingsEfforts={[]} runtimeSettingsDirty={false} runtimeSettingsPending={false} runtimeSettingsError={undefined}
      recheckPending={false} managementPermissionsPending={false} managementPermissionsError={undefined}
      mcpSummary="No connectors" configuredMcpCount={0} usableMcpCount={0} mcpToolCountLabel="0 tools" steering={false}
      onSettingsEngine={noop} onSettingsModel={noop} onSettingsEffort={noop} onNotice={noop} onSaveRuntimeSettings={noop}
      onRecheckEngine={noop} onOpenMaster={noop} onOpenAgent={noop} onUpdateManagementPermissions={noop} onChangeReportingLine={noop} />
  </MutationNotificationProvider>;
}
const content = params.get("case") === "scope"
  ? <ProviderActivitySettingsSection projects={[project as never]} />
  : params.get("case") === "diagnostic" ? <AgentWorkInspector open projectId="project" focus={{ id: "request:failed-request" }} onClose={() => {}} />
  : params.get("case") === "profile" ? <ProfileFixture />
  : params.get("case") === "fresh-session" ? <FreshSessionFixture />
  : params.get("case") === "cancel" ? <MessageDeliveryStatus recipientName={() => "Reviewer"} receipts={["stopping", "stopped", "unconfirmed"].map(runStopState => ({ activationId: runStopState, targetAgentId: "agent", state: "cancelled", providerAcknowledged: true, runStopState })) as never} />
  : params.get("case") === "preview" ? <><ConversationWorkspaceFiles conversationId="chat" projectId="project" />
    <FilePreview title="Nested Markdown" projectId="project" conversationId="chat" path="docs/report.md" mediaType="text/markdown" content={'![Nested photo](images/photo.png)\n\n![Missing photo](images/missing.png)\n\n![Rejected escape](../../outside.png)'} /></>
  : params.get("case") === "download" ? <MutationNotificationProvider>
    <a href="/api/download/good" download="result.txt">Download report</a>
    <a href="/api/download/bad" download="missing.txt">Download missing report</a>
    <button onClick={() => downloadMarkdownTranscript(buildMarkdownTranscript("Transcript", [{ author: "User", text: "marketing", createdAt: "2026-09-29T12:00:00Z" }]), "transcript.md")}>Download transcript</button>
  </MutationNotificationProvider>
  : <div style={{ height: "100dvh" }}><WorkspaceReviewPane projectRoot="/test" agentId="agent" files={files} executionId="selected-run" running={false} backLabel="Back to Chat" onBack={() => { document.body.dataset.returned = "chat"; }} /></div>;
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme(params.get("theme") === "light" ? "light" : "dark")}><CssBaseline /><QueryClientProvider client={client}>{content}</QueryClientProvider></ThemeProvider>);
