import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
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
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { ConversationDto, EngineDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import {
  engineIsAvailable,
  engineUnavailableReason,
  soleAvailableEngineId,
} from "../conversationEngine";
import { queryKeys } from "../queryKeys";
import { useMutationNotification } from "./MutationNotifications";

const MAX_IMPORT_FILE_BYTES = 96 * 1024 * 1024;

interface PortableAgentPreview {
  sourceLabel: string;
  mode: "template" | "full";
  kind: "agent" | "organization";
  agentCount: number;
  artifactCount: number;
  historyMessageCount: number;
  sourceEngines: string[];
  elevatedAgentRefs: string[];
  invalidPermissionShape: boolean;
}

export function ImportAgentForm({
  projectId,
  engines,
  conversations,
  initialConversationId,
  onCancel,
  onPendingChange,
  stickyActions = false,
}: {
  projectId: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  initialConversationId?: string;
  onCancel(): void;
  onPendingChange?(pending: boolean): void;
  stickyActions?: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
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
  const [error, setError] = useState<string>();
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
      conversations.some(conversation => conversation.id === current)
        ? current
        : initialConversationId ?? conversations[0]?.id ?? "",
    );
  }, [conversations, initialConversationId]);

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
    mutationFn: () => api.startAgentPackageImport(
      projectId,
      packageBlob!,
      {
        conversationId, engineMapping,
        ...(elevatedAgents.length > 0 ? { acknowledgeElevatedManagementPermissions: acknowledgeElevatedPermissions } : {}),
      },
      importRequestId.current,
    ),
    onSuccess: (operation) => {
      clearPackageDraft();
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(projectId) });
      notify({
        key: `agent-import:${operation.id}`,
        message: "Agent import started and will continue in the background.",
        severity: "info",
      });
      pendingRef.current = false;
      onPendingChange?.(false);
      onCancel();
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
      setError("This Agent package is larger than the 96 MiB import limit.");
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

  return <Stack spacing={2}>
      <Alert severity="info">Imported history remains private historical context and does not appear as new chat messages. Automations import disabled with new secrets.</Alert>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
        <Button component="label" variant="outlined" startIcon={<UploadFileOutlinedIcon />}>
          Choose JSON File
          <input hidden type="file" accept="application/json,.json" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void loadFile(file);
          }} />
        </Button>
        <Typography variant="body2" color="text.secondary">{fileName ?? "No file selected"}</Typography>
        {fileName && !jsonText ? (
          <Button size="small" color="inherit" onClick={clearPackageDraft}>
            Clear
          </Button>
        ) : null}
      </Stack>
      <TextField
        label="Or paste Agent JSON"
        placeholder="Paste exported JSON here"
        value={jsonText}
        onChange={(event) => updateJsonText(event.target.value)}
        multiline
        minRows={3}
        maxRows={8}
        fullWidth
      />
      {inspecting ? <Alert severity="info">{inspectionPhase ?? "Inspecting package off the main thread…"}</Alert> : null}
      {packagePreview ? <Alert severity="success">
        <Typography variant="body2">
          {packagePreview.agentCount} Agent{packagePreview.agentCount === 1 ? "" : "s"} · {packagePreview.mode === "template" ? "template" : "full"} · {packagePreview.artifactCount} artifact{packagePreview.artifactCount === 1 ? "" : "s"} · {packagePreview.historyMessageCount} history message{packagePreview.historyMessageCount === 1 ? "" : "s"}
        </Typography>
        <Typography variant="caption" color="text.secondary">{packagePreview.sourceLabel}</Typography>
      </Alert> : !inspecting && !error ? <Typography variant="body2" color="text.secondary">
        Use a Full Agent, Full organization, Agent template, or Organization template export.
      </Typography> : null}
      <FormControl fullWidth>
        <InputLabel id="import-chat-label">Destination Chat</InputLabel>
        <Select labelId="import-chat-label" label="Destination Chat" value={conversationId} onChange={(event: SelectChangeEvent) => setConversationId(event.target.value)}>
          {conversations.map((conversation) => <MenuItem key={conversation.id} value={conversation.id}>{conversation.title}</MenuItem>)}
        </Select>
      </FormControl>
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
      <Button variant="contained" disabled={!packageBlob || !packagePreview || inspecting || invalidPermissionShape || !conversationId || sourceEngines.some((source) => {
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
  engines,
  conversations,
  initialConversationId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  initialConversationId?: string;
  onClose(): void;
}): JSX.Element {
  const [pending, setPending] = useState(false);
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
      <DialogTitle>Import Agent or Organization</DialogTitle>
      <DialogContent sx={{ pt: "12px !important" }}>
        {open ? (
          <ImportAgentForm
            projectId={projectId}
            engines={engines}
            conversations={conversations}
            initialConversationId={initialConversationId}
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
