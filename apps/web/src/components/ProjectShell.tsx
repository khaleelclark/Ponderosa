import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { Alert, Box, Button, IconButton, LinearProgress, Stack, Typography, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import type { EngineDto, MasterChatDto, ThreadDetailDto } from "@ponderosa/core";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import { deriveAgentStatus, type AgentStatus } from "../agents";
import { pickAgentName } from "../parkNames";
import { useMasterChats, useThreads } from "../hooks/queries";
import type { Route } from "../routing";
import { AgentDetail } from "./AgentDetail";
import { AgentsTab } from "./AgentsTab";
import { CreateAgentDialog, type CreateAgentInput, CreateMasterChatDialog, type CreateMasterChatInput } from "./dialogs";
import { MasterChatView } from "./MasterChatView";
import { Sidebar } from "./Sidebar";

interface AgentDialogState {
  open: boolean;
  fixedMasterChatId?: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
  defaultName?: string;
}

export function ProjectShell({
  projectId,
  route,
  engines,
  navigate,
}: {
  projectId: string;
  route: Route;
  engines: EngineDto[];
  navigate(route: Route, options?: { replace?: boolean }): void;
}): JSX.Element {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const queryClient = useQueryClient();

  const masterChatsQuery = useMasterChats(projectId);
  const threadsQuery = useThreads(projectId);
  const masterChats = masterChatsQuery.data ?? [];
  const agents = threadsQuery.data ?? [];

  const [masterDialogOpen, setMasterDialogOpen] = useState(false);
  const [agentDialog, setAgentDialog] = useState<AgentDialogState>({ open: false });

  // Per-agent detail powers live status + activity in the sidebar and Agents tab.
  const agentDetailQueries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: ["thread", agent.id],
      queryFn: () => api.getThread(agent.id),
      staleTime: 8_000,
      refetchInterval: 8_000,
    })),
  });

  const detailByAgentId = useMemo(() => {
    const map = new Map<string, ThreadDetailDto | undefined>();
    agents.forEach((agent, index) => map.set(agent.id, agentDetailQueries[index]?.data));
    return map;
  }, [agents, agentDetailQueries]);

  const statusByAgentId = useMemo(() => {
    const map = new Map<string, AgentStatus>();
    agents.forEach((agent) => map.set(agent.id, deriveAgentStatus(detailByAgentId.get(agent.id))));
    return map;
  }, [agents, detailByAgentId]);

  const createMasterChat = useMutation({
    mutationFn: (input: CreateMasterChatInput) => api.createMasterChat(projectId, input),
    onSuccess: (master) => {
      void queryClient.invalidateQueries({ queryKey: ["master-chats", projectId] });
      setMasterDialogOpen(false);
      navigate({ kind: "master-chat", projectId, masterChatId: master.id });
    },
  });

  const createAgent = useMutation({
    mutationFn: (input: CreateAgentInput) =>
      api.createAgent(projectId, input.masterChatId, {
        title: input.title,
        engine: input.engine,
        model: input.model,
        effort: input.effort,
      }),
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: ["threads", projectId] });
      if (agent.masterChatId) {
        void queryClient.invalidateQueries({ queryKey: ["master-chat", agent.masterChatId] });
      }
      setAgentDialog({ open: false });
      navigate({ kind: "agent", projectId, agentId: agent.id });
    },
  });

  const suggestedName = () => pickAgentName(agents.map((agent) => agent.title));

  const openNewAgentFromMaster = (master: MasterChatDto) =>
    setAgentDialog({
      open: true,
      fixedMasterChatId: master.id,
      defaultEngine: master.defaultEngine,
      defaultModel: master.defaultModel,
      defaultEffort: master.defaultEffort,
      defaultName: suggestedName(),
    });

  const sidebarSelection = {
    masterChatId: route.kind === "master-chat" ? route.masterChatId : undefined,
    agentsActive: route.kind === "agents" || route.kind === "agent",
  };

  const sidebar = (
    <Sidebar
      masterChats={masterChats}
      agents={agents}
      statusByAgentId={statusByAgentId}
      selection={sidebarSelection}
      onSelectMasterChat={(masterChatId) => navigate({ kind: "master-chat", projectId, masterChatId })}
      onSelectAgents={() => navigate({ kind: "agents", projectId })}
      onCreateMasterChat={() => setMasterDialogOpen(true)}
    />
  );

  const loading = masterChatsQuery.isLoading || threadsQuery.isLoading;

  if (masterChatsQuery.isError || threadsQuery.isError) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                void masterChatsQuery.refetch();
                void threadsQuery.refetch();
              }}
            >
              Retry
            </Button>
          }
        >
          This project could not be loaded. Check the server connection and try again.
        </Alert>
      </Box>
    );
  }

  let main: JSX.Element;
  if (route.kind === "master-chat") {
    main = (
      <MasterChatView
        key={route.masterChatId}
        masterChatId={route.masterChatId}
        engines={engines}
        statusByAgentId={statusByAgentId}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onNewAgent={openNewAgentFromMaster}
        onArchived={() => navigate({ kind: "agents", projectId })}
      />
    );
  } else if (route.kind === "agent") {
    main = (
      <AgentDetail
        key={route.agentId}
        agentId={route.agentId}
        engines={engines}
        masterChats={masterChats}
        onBack={() => navigate({ kind: "agents", projectId })}
        onOpenMaster={(masterChatId) => navigate({ kind: "master-chat", projectId, masterChatId })}
        onDeleted={() => navigate({ kind: "agents", projectId })}
      />
    );
  } else if (route.kind === "agents") {
    main = (
      <AgentsTab
        agents={agents}
        masterChats={masterChats}
        statusByAgentId={statusByAgentId}
        detailByAgentId={detailByAgentId}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onNewAgent={() => setAgentDialog({ open: true, defaultName: suggestedName() })}
      />
    );
  } else {
    main = (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          Select a master chat or open the Agents view to get started.
        </Alert>
      </Box>
    );
  }

  const dialogs = (
    <>
      <CreateMasterChatDialog
        open={masterDialogOpen}
        engines={engines}
        pending={createMasterChat.isPending}
        error={createMasterChat.isError ? String(createMasterChat.error) : undefined}
        onClose={() => setMasterDialogOpen(false)}
        onCreate={(input) => createMasterChat.mutate(input)}
      />
      <CreateAgentDialog
        open={agentDialog.open}
        engines={engines}
        masterChats={masterChats}
        fixedMasterChatId={agentDialog.fixedMasterChatId}
        defaultEngine={agentDialog.defaultEngine}
        defaultModel={agentDialog.defaultModel}
        defaultEffort={agentDialog.defaultEffort}
        defaultName={agentDialog.defaultName}
        pending={createAgent.isPending}
        error={createAgent.isError ? String(createAgent.error) : undefined}
        onClose={() => setAgentDialog({ open: false })}
        onCreate={(input) => createAgent.mutate(input)}
      />
    </>
  );

  // Mobile: the sidebar is the "list" screen; a selection opens a full-screen
  // detail with a back affordance. Desktop: sidebar + detail side by side.
  if (isMobile) {
    const showList = route.kind === "project";
    return (
      <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto 1fr" }}>
        {loading ? <LinearProgress /> : <Box />}
        {showList ? (
          <Box sx={{ minHeight: 0, overflow: "auto", bgcolor: "background.paper" }}>{sidebar}</Box>
        ) : (
          <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto 1fr" }}>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: "center", px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}
            >
              <IconButton
                aria-label="Back to navigation"
                onClick={() => navigate({ kind: "project", projectId })}
              >
                <ArrowBackIcon />
              </IconButton>
              <Typography variant="subtitle2" color="text.secondary">
                Navigation
              </Typography>
            </Stack>
            <Box sx={{ minHeight: 0, display: "grid" }}>{main}</Box>
          </Box>
        )}
        {dialogs}
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: 0, display: "grid", gridTemplateColumns: "300px 1fr" }}>
      <Box
        sx={{
          borderRight: 1,
          borderColor: "divider",
          overflow: "auto",
          bgcolor: "background.paper",
        }}
      >
        {loading ? <LinearProgress /> : null}
        {sidebar}
      </Box>
      <Box sx={{ minHeight: 0, display: "grid", bgcolor: "#fbfcf8" }}>{main}</Box>
      {dialogs}
    </Box>
  );
}
