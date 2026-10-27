import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import { AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_LIMIT_LABEL, AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL, type AgentDto, type ConversationDto, type EngineDto, type ProjectDto } from "@ponderosa/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { copyText } from "../clipboard";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import {
  engineIsAvailable,
  engineUnavailableReason,
  soleAvailableEngineId,
} from "../conversationEngine";
import { useMutationNotification } from "./MutationNotifications";
import { agentBelongsToConversation } from "../agents";
import { externalAgentImportPrompt } from "./externalAgentImportPrompt";

import { ChatInstructionsImportChoice, chatInstructionsResolution, type ChatInstructionsAction } from "./ChatInstructionsImportChoice";

const MAX_IMPORT_FILE_BYTES = AGENT_PACKAGE_MAX_BYTES;
const LARGE_PASTE_CHARACTERS = 256 * 1024;

interface PortableAgentPreview {
  sourceLabel: string;
  sourceProjectInstructions?: string;
  mode: "template" | "full";
  kind: "agent" | "organization";
  agentCount: number;
  artifactCount: number;
  historyMessageCount: number;
  agentTitles: string[];
  sourceEngines: string[];
  elevatedAgentRefs: string[];
  invalidPermissionShape: boolean;
}

export function ImportAgentForm({
  projectId,
  engines,
  conversations,
  initialConversationId,
  fixedConversationId,
  requireDestinationSelection = false,
  onCancel,
  onPendingChange,
  onSubmitted,
  stickyActions = false,
}: {
  projectId: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  initialConversationId?: string;
  fixedConversationId?: string;
  requireDestinationSelection?: boolean;
  onCancel(): void;
  onPendingChange?(pending: boolean): void;
  onSubmitted?(): void;
  stickyActions?: boolean;
}): JSX.Element {
  const notify = useMutationNotification();
  const [packageBlob, setPackageBlob] = useState<Blob>();
  const [packagePreview, setPackagePreview] = useState<PortableAgentPreview>();
  const [inspecting, setInspecting] = useState(false);
  const [inspectionPhase, setInspectionPhase] = useState<string>();
  const [fileName, setFileName] = useState<string>();
  const [jsonText, setJsonText] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [engineMapping, setEngineMapping] = useState<Record<string, string>>({});
  const [acknowledgeElevatedPermissions, setAcknowledgeElevatedPermissions] = useState(false);
  const [instructionsAction, setInstructionsAction] = useState<ChatInstructionsAction>("");
  const sourceInstructions = packagePreview?.sourceProjectInstructions;
  const destinationInstructions = conversations.find(chat => chat.id === conversationId)?.instructions ?? "";
  const instructionsConflict = Boolean(sourceInstructions && destinationInstructions && sourceInstructions !== destinationInstructions);
  useEffect(() => { setInstructionsAction(""); importRequestId.current = createClientId(); }, [sourceInstructions, destinationInstructions, conversationId]);
  const [error, setError] = useState<string>();
  const destinationAgentsQuery = useQuery<AgentDto[]>({
    queryKey: queryKeys.agents.project(projectId),
    queryFn: () => api.listAgents(projectId),
    enabled: Boolean(packagePreview && conversationId),
  });
  const normalizeName = (value: string) => value.trim().normalize("NFKC").toLocaleLowerCase();
  const importedTitles = packagePreview?.agentTitles ?? [];
  const existingTitles = new Set((destinationAgentsQuery.data ?? [])
    .filter(agent => agentBelongsToConversation(agent, conversationId))
    .map(agent => normalizeName(agent.title)));
  const overlappingTitles = [...new Set(importedTitles.filter(title => existingTitles.has(normalizeName(title))))];
  const seenTitles = new Set<string>();
  const repeatedTitles = [...new Set(importedTitles.filter(title => {
    const key = normalizeName(title);
    if (seenTitles.has(key)) return true;
    seenTitles.add(key);
    return false;
  }))];
  const previewWorker = useRef<Worker>();
  const previewRequestId = useRef(0);
  const importRequestId = useRef(createClientId());
  const pendingRef = useRef(false);

  const cancelInspection = useCallback(() => {
    previewWorker.current?.terminate();
    previewWorker.current = undefined;
    previewRequestId.current += 1;
  }, []);

  const clearPackageDraft = useCallback(() => {
    cancelInspection();
    setPackageBlob(undefined);
    setPackagePreview(undefined);
    setInspecting(false);
    setInspectionPhase(undefined);
    setFileName(undefined);
    setJsonText("");
    setEngineMapping({});
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
    importRequestId.current = createClientId();
  }, [cancelInspection]);

  const closeForm = () => {
    if (pendingRef.current) return;
    clearPackageDraft();
    setConversationId("");
    onCancel();
  };

  useEffect(() => () => cancelInspection(), [cancelInspection]);

  useEffect(() => {
    setConversationId(current =>
      fixedConversationId && conversations.some(conversation => conversation.id === fixedConversationId)
        ? fixedConversationId
        : conversations.some(conversation => conversation.id === current)
        ? current
        : initialConversationId && conversations.some(conversation => conversation.id === initialConversationId)
          ? initialConversationId
          : requireDestinationSelection && conversations.length > 1
            ? ""
            : conversations[0]?.id ?? "",
    );
  }, [conversations, fixedConversationId, initialConversationId, requireDestinationSelection]);

  const invalidPermissionShape = packagePreview?.invalidPermissionShape ?? false;
  const elevatedAgents = invalidPermissionShape
    ? []
    : packagePreview?.elevatedAgentRefs ?? [];
  const sourceEngines = packagePreview?.sourceEngines ?? [];
  useEffect(() => {
    const automatic = soleAvailableEngineId(engines);
    if (!automatic || sourceEngines.length === 0) return;
    setEngineMapping(current => Object.fromEntries(sourceEngines.map(source => {
      const selected = engines.find(engine => engine.id === current[source]);
      return [source, selected && engineIsAvailable(selected) ? selected.id : automatic];
    })));
  }, [engines, sourceEngines.join("\0")]);
  const importAgents = useMutation({
    mutationFn: async () => api.startAgentPackageImport(
      projectId,
      packageBlob!,
      {
        conversationId, engineMapping,
        chatInstructionsResolution: await chatInstructionsResolution(instructionsAction, destinationInstructions),
        ...(elevatedAgents.length > 0 ? { acknowledgeElevatedManagementPermissions: acknowledgeElevatedPermissions } : {}),
      },
      importRequestId.current,
    ),
    onSuccess: (operation) => {
      clearPackageDraft();
      notify({
        key: `agent-import:${operation.id}`,
        message: "Agent import started and will continue in the background.",
        severity: "info",
      });
      pendingRef.current = false;
      onPendingChange?.(false);
      (onSubmitted ?? onCancel)();
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "Import failed"),
    onSettled: () => {
      pendingRef.current = false;
      onPendingChange?.(false);
    },
  });
  const inspectPackage = useCallback((blob: Blob, sourceName?: string) => {
    cancelInspection();
    importRequestId.current = createClientId();
    if (blob.size > MAX_IMPORT_FILE_BYTES) {
      setPackageBlob(undefined);
      setPackagePreview(undefined);
      setInspecting(false);
      setInspectionPhase(undefined);
      setFileName(sourceName);
      setEngineMapping({});
      setAcknowledgeElevatedPermissions(false);
      setError(`This Agent package is larger than the ${AGENT_PACKAGE_LIMIT_LABEL} import limit.`);
      return;
    }
    const id = ++previewRequestId.current;
    const worker = new Worker(
      new URL("./agent-package-preview.worker.ts", import.meta.url),
      { type: "module" },
    );
    previewWorker.current = worker;
    worker.onmessage = (event: MessageEvent<{
      id: number;
      phase?: string;
      preview?: PortableAgentPreview;
      error?: string;
    }>) => {
      if (event.data.id !== previewRequestId.current) return;
      if (event.data.phase) {
        setInspectionPhase(event.data.phase);
        return;
      }
      setInspecting(false);
      setInspectionPhase(event.data.preview ? "Ready to import" : undefined);
      setPackagePreview(event.data.preview);
      setError(event.data.error);
      worker.terminate();
      if (previewWorker.current === worker) previewWorker.current = undefined;
    };
    worker.onerror = () => {
      if (id !== previewRequestId.current) return;
      setInspecting(false);
      setInspectionPhase(undefined);
      setPackagePreview(undefined);
      setError("Ponderosa could not inspect that package.");
      worker.terminate();
      if (previewWorker.current === worker) previewWorker.current = undefined;
    };
    setPackageBlob(blob);
    setPackagePreview(undefined);
    setInspecting(true);
    setInspectionPhase("Reading import");
    setFileName(sourceName);
    setEngineMapping({});
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
    worker.postMessage({ id, blob });
  }, [cancelInspection]);

  const loadFile = async (file: File) => {
    setJsonText("");
    inspectPackage(file, file.name);
  };

  useEffect(() => {
    if (!jsonText.trim()) return;
    const timer = window.setTimeout(() => {
      inspectPackage(
        new Blob([jsonText], { type: "application/json" }),
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [inspectPackage, jsonText]);

  const updateJsonText = (value: string) => {
    cancelInspection();
    setJsonText(value);
    setPackageBlob(undefined);
    setPackagePreview(undefined);
    setInspecting(false);
    setInspectionPhase(undefined);
    setFileName(undefined);
    setEngineMapping({});
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
  };

  const copyExternalPrompt = async () => {
    try {
      await copyText(externalAgentImportPrompt(new Date().toISOString()));
      notify({ key: "copy-import-prompt", message: "Copied" });
    } catch {
      notify({ key: "copy-import-prompt", message: "Could not copy the prompt. Check clipboard access and try again.", severity: "error" });
    }
  };

  return <Stack spacing={2}>
      <Alert severity="info">Imported history remains private historical context and does not appear as new chat messages. Agent packages do not include credentials.</Alert>
      <Paper component="section" variant="outlined" aria-label="Import an external AI chat" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ xs: "flex-start", sm: "center" }} justifyContent="space-between">
          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2">Import a Codex or Claude chat</Typography>
            <Typography variant="body2" color="text.secondary">
              Give this prompt to the agent in that chat. Then paste or upload the JSON it creates below.
            </Typography>
          </Stack>
          <Button size="small" variant="outlined" startIcon={<ContentCopyOutlinedIcon />} onClick={() => void copyExternalPrompt()} sx={{ flexShrink: 0 }}>
            Copy conversion prompt
          </Button>
        </Stack>
      </Paper>
      <Typography variant="body2" color="text.secondary">Agent and organization packages: up to {AGENT_PACKAGE_LIMIT_LABEL}, with up to {AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL} of embedded artifacts. Choose a file for large imports.</Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
        <Button component="label" variant="outlined" startIcon={<UploadFileOutlinedIcon />}>
          Choose JSON File
          <input hidden type="file" accept="application/json,.json" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void loadFile(file);
          }} />
        </Button>
        {fileName && packageBlob && !jsonText ? <Paper
          role="group"
          aria-label="Selected JSON package"
          variant="outlined"
          sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, py: 0.5, minWidth: 0, maxWidth: "100%", flex: 1 }}
        >
          <InsertDriveFileOutlinedIcon fontSize="small" color="action" />
          <Stack sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="body2" noWrap>{fileName}</Typography>
            <Typography variant="caption" color="text.secondary" aria-live="polite">
              {packageBlob.size >= 1_000_000
                ? `${(packageBlob.size / 1_000_000).toFixed(1)} MB`
                : `${Math.ceil(packageBlob.size / 1_000)} KB`}
              {" · "}
              {inspecting ? inspectionPhase ?? "Inspecting" : packagePreview ? "Ready to import" : error ? "Could not inspect" : "Selected"}
            </Typography>
          </Stack>
          <Button size="small" color="inherit" onClick={clearPackageDraft}>Remove</Button>
        </Paper> : <>
          <Typography variant="body2" color="text.secondary">{fileName ?? "No file selected"}</Typography>
          {fileName && !jsonText ? <Button size="small" color="inherit" onClick={clearPackageDraft}>Clear</Button> : null}
        </>}
      </Stack>
      <TextField
        label="Or paste Agent JSON"
        placeholder="Paste exported JSON here"
        value={jsonText}
        onPasteCapture={(event) => {
          const field = event.target;
          if (!(field instanceof HTMLTextAreaElement)) return;
          const pasted = event.clipboardData?.getData("text/plain");
          if (!pasted) return;
          const before = field.value.slice(0, field.selectionStart);
          const after = field.value.slice(field.selectionEnd);
          const nextLength = before.length + pasted.length + after.length;
          if (nextLength < LARGE_PASTE_CHARACTERS) return;
          event.preventDefault();
          setJsonText("");
          const blob = new Blob([before, pasted, after], { type: "application/json" });
          inspectPackage(blob, "pasted-agent-package.json");
        }}
        onChange={(event) => updateJsonText(event.target.value)}
        multiline
        minRows={3}
        maxRows={8}
        fullWidth
      />
      {inspecting && !fileName ? <Alert severity="info">{inspectionPhase ?? "Inspecting package off the main thread…"}</Alert> : null}
      {packagePreview ? <Alert severity="success">
        <Typography variant="body2">
          {packagePreview.agentCount} Agent{packagePreview.agentCount === 1 ? "" : "s"} · {packagePreview.mode === "template" ? "template" : "full"} · {packagePreview.artifactCount} artifact{packagePreview.artifactCount === 1 ? "" : "s"} · {packagePreview.historyMessageCount} history message{packagePreview.historyMessageCount === 1 ? "" : "s"}
        </Typography>
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          Will import: {packagePreview.kind === "organization" ? "the Agent and its included descendants" : "one Agent"}, setup{packagePreview.mode === "full" ? ", private history, managed artifacts, and source Chat instructions when present" : " only"}.
        </Typography>
        <Typography variant="body2">Will not import: credentials.</Typography>
        <Typography variant="caption" color="text.secondary">{packagePreview.sourceLabel}</Typography>
      </Alert> : !inspecting && !error ? <Typography variant="body2" color="text.secondary">
        Choose or paste a Ponderosa Agent package. It can contain one Agent or an organization.
      </Typography> : null}
      {conversations.length === 0 ? <Alert severity="warning">This workspace has no destination chats. Create a chat before importing, or choose another workspace.</Alert> : fixedConversationId || conversations.length === 1 ? <Typography variant="body2" color="text.secondary">
        Destination chat: {conversations.find(conversation => conversation.id === fixedConversationId)?.title ?? conversations[0]!.title}
      </Typography> : <FormControl fullWidth>
        <InputLabel id="import-chat-label">Destination chat</InputLabel>
        <Select labelId="import-chat-label" label="Destination chat" value={conversationId} onChange={(event: SelectChangeEvent) => setConversationId(event.target.value)}>
          {conversations.map((conversation) => <MenuItem key={conversation.id} value={conversation.id}>{conversation.title}</MenuItem>)}
        </Select>
      </FormControl>}
      <ChatInstructionsImportChoice source={sourceInstructions} destination={destinationInstructions}
        value={instructionsAction} onChange={value => { setInstructionsAction(value); importRequestId.current = createClientId(); }} />
      {packagePreview && repeatedTitles.length ? <Alert severity="warning">
        Repeated within this package: {repeatedTitles.slice(0, 5).join(", ")}{repeatedTitles.length > 5 ? ` and ${repeatedTitles.length - 5} more` : ""}. These will become separate Agents with the same name.
      </Alert> : null}
      {packagePreview && conversationId ? (
        destinationAgentsQuery.isFetching ? <Typography role="status" variant="body2" color="text.secondary">Checking names in the destination chat…</Typography>
          : destinationAgentsQuery.isError ? <Alert severity="warning">Could not check existing Agent names in this chat. Importing still creates new Agents and does not replace existing ones.</Alert>
          : overlappingTitles.length ? <Alert severity="warning">
            {overlappingTitles.length ? <Typography variant="body2">Already in this chat: {overlappingTitles.slice(0, 5).join(", ")}{overlappingTitles.length > 5 ? ` and ${overlappingTitles.length - 5} more` : ""}.</Typography> : null}
            <Typography variant="body2">Import creates separate Agents; it will not overwrite existing ones.</Typography>
          </Alert> : <Typography variant="body2" color="text.secondary">No matching Agent names in the destination chat.</Typography>
      ) : null}
      {sourceEngines.map((source) => {
        const label = sourceEngines.length === 1
          ? "Default Engine"
          : `Engine for ${source}`;
        return <FormControl key={source} fullWidth>
          <InputLabel id={`engine-map-${source}`}>{label}</InputLabel>
          <Select labelId={`engine-map-${source}`} label={label} value={engineMapping[source] ?? ""} onChange={(event: SelectChangeEvent) => setEngineMapping((current) => ({ ...current, [source]: event.target.value }))}>
            {engines.map((engine) => <MenuItem key={engine.id} value={engine.id} disabled={!engineIsAvailable(engine)}>{engine.displayName}{engineIsAvailable(engine) ? "" : ` — ${engineUnavailableReason(engine)}`}</MenuItem>)}
          </Select>
        </FormControl>;
      })}
      {invalidPermissionShape ? <Alert severity="error">
        This package has invalid management permissions. Both permission values must be true or false booleans.
      </Alert> : null}
      {elevatedAgents.length > 0 ? <Alert severity="warning">
        <Typography variant="body2" sx={{ mb: 1 }}>
          {elevatedAgents.length} imported Agent{elevatedAgents.length === 1 ? "" : "s"} will be allowed to autonomously delete descendants or rearrange their organization.
        </Typography>
        <FormControlLabel
          control={<Checkbox checked={acknowledgeElevatedPermissions} onChange={(event) => setAcknowledgeElevatedPermissions(event.target.checked)} />}
          label="Import these elevated management permissions"
        />
      </Alert> : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Stack direction="row" spacing={1} sx={{
        justifyContent: "flex-end",
        ...(stickyActions ? {
          position: "absolute",
          zIndex: 2,
          bottom: 0,
          left: 0,
          right: 0,
          px: { xs: 2, sm: 3 },
          py: 1.5,
          bgcolor: "background.paper",
          borderTop: 1,
          borderColor: "divider",
        } : {}),
      }}>
      <Button disabled={importAgents.isPending} onClick={closeForm}>Cancel</Button>
      <Button variant="contained" disabled={!packageBlob || !packagePreview || inspecting || destinationAgentsQuery.isFetching || (instructionsConflict && !instructionsAction) || invalidPermissionShape || !conversationId || sourceEngines.some((source) => {
        const target = engines.find(engine => engine.id === engineMapping[source]);
        return !engineIsAvailable(target);
      }) || (elevatedAgents.length > 0 && !acknowledgeElevatedPermissions) || importAgents.isPending} onClick={() => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        onPendingChange?.(true);
        importAgents.mutate();
      }}>
        {importAgents.isPending ? "Importing…" : "Import"}
      </Button>
      </Stack>
  </Stack>;
}

export function ImportAgentDialog({
  open,
  projectId,
  projects = [],
  initialProjectId,
  engines,
  conversations,
  initialConversationId,
  onClose,
}: {
  open: boolean;
  projectId?: string;
  projects?: ProjectDto[];
  initialProjectId?: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  initialConversationId?: string;
  onClose(): void;
}): JSX.Element {
  const [pending, setPending] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId ?? "");
  useEffect(() => {
    if (open && !projectId) setSelectedProjectId(initialProjectId ?? "");
  }, [open, projectId, initialProjectId]);
  const destinationProjectId = projectId ?? selectedProjectId;
  const destinationConversations = useQuery({
    queryKey: queryKeys.conversations.project(destinationProjectId),
    queryFn: () => api.listConversations(destinationProjectId),
    enabled: open && !projectId && Boolean(destinationProjectId),
  });
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const openRef = useRef(false);
  if (open && !openRef.current) generationRef.current += 1;
  openRef.current = open;
  const generation = generationRef.current;
  useEffect(() => () => {
    generationRef.current += 1;
    openRef.current = false;
  }, []);
  const updatePending = (nextPending: boolean) => {
    pendingRef.current = nextPending;
    setPending(nextPending);
  };
  const close = () => {
    if (!pendingRef.current) onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      disableEscapeKeyDown={pending}
      fullWidth
      maxWidth="md"
      slotProps={{ paper: { "aria-busy": pending || undefined } }}
    >
      <DialogTitle>Import Agent package</DialogTitle>
      <DialogContent sx={{ pt: "12px !important" }}>
        {!projectId ? (
          <FormControl fullWidth size="small" sx={{ mb: 2 }}>
            <InputLabel id="import-package-project-label">Destination workspace</InputLabel>
            <Select
              labelId="import-package-project-label"
              label="Destination workspace"
              value={selectedProjectId}
              disabled={pending}
              onChange={event => setSelectedProjectId(event.target.value)}
            >
              {projects.map(project => (
                <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : null}
        {!projectId && destinationConversations.isPending && destinationProjectId ? (
          <Typography variant="body2" color="text.secondary">Loading destination chats…</Typography>
        ) : null}
        {!projectId && destinationConversations.isError ? (
          <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => void destinationConversations.refetch()}>Retry</Button>}>Could not load destination chats.</Alert>
        ) : null}
        {!destinationProjectId ? (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">Choose the workspace that owns the destination chat.</Typography>
            <Button onClick={close} sx={{ alignSelf: "flex-end" }}>Cancel</Button>
          </Stack>
        ) : null}
        {open && destinationProjectId && (projectId || destinationConversations.isSuccess) ? (
          <ImportAgentForm
            key={destinationProjectId}
            projectId={destinationProjectId}
            engines={engines}
            conversations={projectId ? conversations : destinationConversations.data?.filter(chat => !chat.deletedAt) ?? []}
            initialConversationId={projectId ? initialConversationId : undefined}
            requireDestinationSelection={!projectId}
            onCancel={close}
            onPendingChange={nextPending => {
              if (
                openRef.current &&
                generationRef.current === generation
              ) updatePending(nextPending);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
