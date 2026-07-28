import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
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
import { queryKeys } from "../queryKeys";

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

export function ImportAgentDialog({
  open,
  projectId,
  engines,
  conversations,
  initialConversationId,
  onClose,
  onImported,
}: {
  open: boolean;
  projectId: string;
  engines: EngineDto[];
  conversations: ConversationDto[];
  initialConversationId?: string;
  onClose(): void;
  onImported(agentId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [packageBlob, setPackageBlob] = useState<Blob>();
  const [packagePreview, setPackagePreview] = useState<PortableAgentPreview>();
  const [inspecting, setInspecting] = useState(false);
  const [fileName, setFileName] = useState<string>();
  const [jsonText, setJsonText] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [engineMapping, setEngineMapping] = useState<Record<string, string>>({});
  const [acknowledgeElevatedPermissions, setAcknowledgeElevatedPermissions] = useState(false);
  const [error, setError] = useState<string>();
  const previewWorker = useRef<Worker>();
  const previewRequestId = useRef(0);

  const clearPackageDraft = useCallback(() => {
    previewRequestId.current += 1;
    setPackageBlob(undefined);
    setPackagePreview(undefined);
    setInspecting(false);
    setFileName(undefined);
    setJsonText("");
    setEngineMapping({});
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
  }, []);

  const closeDialog = () => {
    clearPackageDraft();
    setConversationId("");
    onClose();
  };

  useEffect(() => {
    const worker = new Worker(
      new URL("./agent-package-preview.worker.ts", import.meta.url),
      { type: "module" },
    );
    previewWorker.current = worker;
    worker.onmessage = (event: MessageEvent<{
      id: number;
      preview?: PortableAgentPreview;
      error?: string;
    }>) => {
      if (event.data.id !== previewRequestId.current) return;
      setInspecting(false);
      setPackagePreview(event.data.preview);
      setError(event.data.error);
    };
    worker.onerror = () => {
      setInspecting(false);
      setPackagePreview(undefined);
      setError("Ponderosa could not inspect that package.");
    };
    return () => {
      worker.terminate();
      previewWorker.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!open) {
      clearPackageDraft();
      setConversationId("");
      return;
    }
    setConversationId(current =>
      conversations.some(conversation => conversation.id === current)
        ? current
        : initialConversationId ?? conversations[0]?.id ?? "",
    );
  }, [clearPackageDraft, conversations, initialConversationId, open]);

  const invalidPermissionShape = packagePreview?.invalidPermissionShape ?? false;
  const elevatedAgents = invalidPermissionShape
    ? []
    : packagePreview?.elevatedAgentRefs ?? [];
  const sourceEngines = packagePreview?.sourceEngines ?? [];
  const importAgents = useMutation({
    mutationFn: () => api.importAgentPackageBlob(projectId, packageBlob!, {
      conversationId, engineMapping,
      ...(elevatedAgents.length > 0 ? { acknowledgeElevatedManagementPermissions: acknowledgeElevatedPermissions } : {}),
    }),
    onSuccess: (result) => {
      clearPackageDraft();
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(projectId) });
      onClose();
      onImported(result.rootAgentId);
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "Import failed"),
  });
  const inspectPackage = useCallback((blob: Blob, sourceName?: string) => {
    if (blob.size > MAX_IMPORT_FILE_BYTES) {
      setPackageBlob(undefined);
      setPackagePreview(undefined);
      setInspecting(false);
      setFileName(sourceName);
      setEngineMapping({});
      setAcknowledgeElevatedPermissions(false);
      setError("This Agent package is larger than the 96 MiB import limit.");
      return;
    }
    const id = ++previewRequestId.current;
    setPackageBlob(blob);
    setPackagePreview(undefined);
    setInspecting(true);
    setFileName(sourceName);
    setEngineMapping({});
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
    previewWorker.current?.postMessage({ id, blob });
  }, []);

  const loadFile = async (file: File) => {
    setJsonText("");
    inspectPackage(file, file.name);
  };

  useEffect(() => {
    if (!open || !jsonText.trim()) return;
    const timer = window.setTimeout(() => {
      inspectPackage(
        new Blob([jsonText], { type: "application/json" }),
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [inspectPackage, jsonText, open]);

  const updateJsonText = (value: string) => {
    previewRequestId.current += 1;
    setJsonText(value);
    setPackageBlob(undefined);
    setPackagePreview(undefined);
    setInspecting(false);
    setFileName(undefined);
    setEngineMapping({});
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
  };

  return <Dialog open={open} onClose={closeDialog} fullWidth maxWidth="md">
    <DialogTitle>Import Agent or Organization</DialogTitle>
    <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
      <Alert severity="info">Imported history remains private historical context and does not appear as new chat messages. Triggers import disabled with new secrets.</Alert>
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
      {inspecting ? <Alert severity="info">Inspecting package off the main thread…</Alert> : null}
      {packagePreview ? <Alert severity="success">
        <Typography variant="body2">
          {packagePreview.agentCount} Agent{packagePreview.agentCount === 1 ? "" : "s"} · {packagePreview.mode === "template" ? "template" : "full"} · {packagePreview.artifactCount} artifact{packagePreview.artifactCount === 1 ? "" : "s"} · {packagePreview.historyMessageCount} history message{packagePreview.historyMessageCount === 1 ? "" : "s"}
        </Typography>
        <Typography variant="caption" color="text.secondary">{packagePreview.sourceLabel}</Typography>
      </Alert> : !inspecting && !error ? <Typography variant="body2" color="text.secondary">
        Use a Full Agent, Full organization, Agent template, or Organization template export.
      </Typography> : null}
      <FormControl fullWidth>
        <InputLabel id="import-chat-label">Destination Project chat</InputLabel>
        <Select labelId="import-chat-label" label="Destination Project chat" value={conversationId} onChange={(event: SelectChangeEvent) => setConversationId(event.target.value)}>
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
            {engines.map((engine) => <MenuItem key={engine.id} value={engine.id}>{engine.displayName}{engine.enabled === false ? " — Disabled" : ""}</MenuItem>)}
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
    </Stack></DialogContent>
    <DialogActions>
      <Button onClick={closeDialog}>Cancel</Button>
      <Button variant="contained" disabled={!packageBlob || !packagePreview || inspecting || invalidPermissionShape || !conversationId || sourceEngines.some((source) => !engineMapping[source]) || (elevatedAgents.length > 0 && !acknowledgeElevatedPermissions) || importAgents.isPending} onClick={() => importAgents.mutate()}>
        {importAgents.isPending ? "Importing…" : "Import"}
      </Button>
    </DialogActions>
  </Dialog>;
}
