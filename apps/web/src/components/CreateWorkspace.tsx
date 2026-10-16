import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import CloseIcon from "@mui/icons-material/Close";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import type {
  EngineDto,
  ProjectDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { queryKeys } from "../queryKeys";
import type { Route } from "../routing";
import { ConfirmDialog } from "./ConfirmationDialogs";
import { IconTitle } from "./IconTitle";
import { MobileNavigationButton } from "./MobileNavigationContext";
import { AgentCreateSurface } from "./AgentCreateDialog";
import { PrimaryHeaderActionsOutlet } from "./PrimaryHeaderActions";
import { NewChatComposer } from "./NewChatComposer";
import { useReloadBlocker } from "../reloadSafety";

const resourcePresentation = {
  chat: {
    icon: <ChatBubbleOutlineIcon />,
    title: "New Chat",
    description: "Start a conversation with its own team and working context.",
  },
  agent: {
    icon: <SmartToyOutlinedIcon />,
    title: "Create Agent",
    description: "Add a managed worker with its own role and runtime to a Chat.",
  },
} satisfies Record<Extract<Route, { kind: "create" }>["resource"], {
  icon: ReactElement;
  title: string;
  description: string;
}>;

function CreateSurface({
  route,
  children,
}: {
  route: Extract<Route, { kind: "create" }>;
  children: ReactNode;
}): JSX.Element {
  const presentation = resourcePresentation[route.resource];
  const header = <Stack direction="row" spacing={1} sx={{ minWidth: 0, mb: { xs: route.resource === "chat" ? 1 : 2.5, sm: 2.5 }, minHeight: { xs: 48, sm: 0 }, alignItems: "center" }}>
    <MobileNavigationButton />
    <Box sx={{ minWidth: 0, flex: 1 }}>
      <IconTitle icon={presentation.icon} title={presentation.title} component="h1" />
      <Typography color="text.secondary" sx={{ mt: 0.5, display: route.resource === "chat" ? { xs: "none", sm: "block" } : undefined }}>
        {presentation.description}
      </Typography>
    </Box>
    <PrimaryHeaderActionsOutlet />
  </Stack>;
  if (route.resource === "chat") return (
    <Box sx={{ height: "100%", minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", px: { xs: 2, md: 4 }, pt: { xs: 1, sm: 3 } }}>
      {header}
      <Box sx={{ minHeight: 0, minWidth: 0 }}>{children}</Box>
    </Box>
  );
  return (
    <Box
      className="ponderosa-scroll"
      sx={{ minHeight: 0, overflowY: "auto", px: { xs: 2, md: 4 }, py: 3 }}
    >
      <Box sx={{ width: "100%", maxWidth: 780, mx: "auto" }}>
        {header}
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          {children}
        </Paper>
      </Box>
    </Box>
  );
}

export function CreateWorkspace({
  route,
  projects,
  engines,
  enginesLoaded = true,
  preferences,
  onCancel,
  onNavigate,
}: {
  route: Extract<Route, { kind: "create" }>;
  projects: ProjectDto[];
  engines: EngineDto[];
  enginesLoaded?: boolean;
  preferences: WorkspacePreferencesDto;
  onCancel(): void;
  onNavigate(route: Route): void;
}): JSX.Element {
  if (route.resource === "chat") return <CreateFormContent
    route={route} projects={projects} engines={engines} enginesLoaded={enginesLoaded}
    preferences={preferences} onCancel={onCancel} onNavigate={onNavigate}
  />;
  return <CreateSurface route={route}>
    <CreateFormContent
      route={route}
      projects={projects}
      engines={engines}
      enginesLoaded={enginesLoaded}
      preferences={preferences}
      onCancel={onCancel}
      onNavigate={onNavigate}
    />
  </CreateSurface>;
}

export type CreationRequest = Omit<
  Extract<Route, { kind: "create" }>,
  "kind" | "surface"
>;

function CreateFormContent({
  route,
  projects,
  engines,
  enginesLoaded = true,
  preferences,
  onCancel,
  onNavigate,
  onDirty,
  onPendingChange,
  onSubmitted,
  anchoredActions = false,
}: {
  route: Extract<Route, { kind: "create" }>;
  projects: ProjectDto[];
  engines: EngineDto[];
  enginesLoaded?: boolean;
  preferences: WorkspacePreferencesDto;
  onCancel(): void;
  onNavigate(route: Route): void;
  onDirty?(): void;
  onPendingChange?(pending: boolean): void;
  onSubmitted?(): void;
  anchoredActions?: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const refresh = (kind: "project" | "conversation" | "agent") => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind(kind) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceResourceRecency.all });
  };
  const content = route.resource === "chat" ? (
    <NewChatComposer
      key={route.creationKey ?? "new-chat"}
      creationKey={route.creationKey}
      onConfigureProvider={() => onNavigate({ kind: "settings", section: "providers" })}
      onCancel={onCancel}
      onPendingChange={onPendingChange}
      engines={engines}
      enginesLoaded={enginesLoaded}
      preferences={preferences}
      onCreated={(projectId, conversationId) => {
        refresh("conversation");
        refresh("project");
        onNavigate({ kind: "conversation", projectId, conversationId });
      }}
    />
  ) : (
    <AgentCreateSurface
      projects={projects}
      engines={engines}
      initialProjectId={route.projectId}
      fixedConversationId={route.conversationId}
      initialManagerAgentId={route.managerAgentId}
      stickyActions={anchoredActions}
      onPendingChange={onPendingChange}
      onImportSubmitted={onSubmitted ?? onCancel}
      onCancel={onCancel}
      onCreated={(projectId, agent) => {
        refresh("agent");
        refresh("project");
        onNavigate({ kind: "agent", projectId, agentId: agent.id });
      }}
      onImported={(projectId, agentId) => {
        refresh("agent");
        refresh("project");
        onNavigate({ kind: "agent", projectId, agentId });
      }}
    />
  );
  return (
    <Box
      onChange={onDirty}
      onInput={onDirty}
      sx={{ minWidth: 0, minHeight: 0, height: route.resource === "chat" ? "100%" : undefined }}
    >
      {content}
    </Box>
  );
}

export function ContextualCreateDialog({
  request,
  projects,
  engines,
  enginesLoaded = true,
  preferences,
  onClose,
  onNavigate,
}: {
  request?: CreationRequest;
  projects: ProjectDto[];
  engines: EngineDto[];
  enginesLoaded?: boolean;
  preferences: WorkspacePreferencesDto;
  onClose(): void;
  onNavigate(route: Route): void;
}): JSX.Element {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pending, setPending] = useState(false);
  useReloadBlocker("contextual-create", dirty || pending);
  useEffect(() => {
    if (request) {
      setDirty(false);
      setConfirmDiscard(false);
      setPending(false);
    }
  }, [request?.resource, request?.projectId, request?.conversationId, request?.managerAgentId]);
  const route = request
    ? { kind: "create" as const, ...request, surface: "workspace" as const }
    : undefined;
  const close = () => {
    if (pending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };
  const title = route ? resourcePresentation[route.resource].title : "Create";
  const icon = route ? resourcePresentation[route.resource].icon : null;
  return (
    <>
      <Dialog
        open={Boolean(route)}
        onClose={close}
        disableEscapeKeyDown={pending}
        fullScreen={fullScreen}
        fullWidth
        maxWidth={route?.resource === "agent" ? "md" : "sm"}
        aria-labelledby="contextual-create-title"
        slotProps={{
          paper: {
            sx: {
              position: "relative",
              maxHeight: fullScreen ? "100dvh" : "min(90dvh, 900px)",
              display: "grid",
              gridTemplateRows: "auto minmax(0, 1fr)",
            },
          },
        }}
      >
        <Box sx={{ position: "relative" }}>
          <DialogTitle id="contextual-create-title" sx={{ pr: 7 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              {icon}
              <Typography component="span" variant="h6" fontWeight={800}>
                {title}
              </Typography>
            </Stack>
          </DialogTitle>
          <IconButton
            aria-label={`Close ${title}`}
            disabled={pending}
            onClick={close}
            sx={{ position: "absolute", right: 12, top: 12 }}
          >
            <CloseIcon />
          </IconButton>
        </Box>
        <DialogContent
          className="ponderosa-scroll"
          sx={{
            minHeight: 0,
            overflowY: "auto",
            pt: "12px !important",
            pb: `max(96px, calc(72px + env(safe-area-inset-bottom)))`,
          }}
        >
          {route ? (
            <CreateFormContent
              key={[route.resource, route.projectId ?? "", route.conversationId ?? "", route.managerAgentId ?? ""].join(":")}
              route={route}
              projects={projects}
              engines={engines}
              enginesLoaded={enginesLoaded}
              preferences={preferences}
              onCancel={close}
              onDirty={() => setDirty(true)}
              onPendingChange={setPending}
              onSubmitted={() => {
                setDirty(false);
                setPending(false);
                setConfirmDiscard(false);
                onClose();
              }}
              anchoredActions
              onNavigate={next => {
                setDirty(false);
                onClose();
                onNavigate(next);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        title={`Discard this unfinished ${route ? resourcePresentation[route.resource].title.replace("Create ", "") : "item"}?`}
        confirmLabel="Discard and Close"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          setDirty(false);
          onClose();
        }}
      >
        <Typography sx={{ pt: 1 }}>Your entered information will be lost.</Typography>
      </ConfirmDialog>
    </>
  );
}
