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
import type { AgentPortablePackageDto, ConversationDto, EngineDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

const MAX_IMPORT_FILE_BYTES = 96 * 1024 * 1024;

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
  const [importJson, setImportJson] = useState("");
  const [fileName, setFileName] = useState<string>();
  const [conversationId, setConversationId] = useState("");
  const [engineMapping, setEngineMapping] = useState<Record<string, string>>({});
  const [acknowledgeElevatedPermissions, setAcknowledgeElevatedPermissions] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setConversationId(initialConversationId ?? conversations[0]?.id ?? "");
    setAcknowledgeElevatedPermissions(false);
    setError(undefined);
  }, [conversations, initialConversationId, open]);

  const parsedPackage = useMemo(() => {
    try {
      const value = JSON.parse(importJson || "null") as AgentPortablePackageDto;
      return value?.schema === "ponderosa.agent-package.v1" && Array.isArray(value.agents) ? value : undefined;
    } catch {
      return undefined;
    }
  }, [importJson]);
  const invalidPermissionShape = Boolean(parsedPackage?.agents.some((node) => {
    const permissions = node.managementPermissions as unknown;
    return !permissions || typeof permissions !== "object" || Array.isArray(permissions) ||
      typeof (permissions as Record<string, unknown>).allowAutomaticDescendantDeletion !== "boolean" ||
      typeof (permissions as Record<string, unknown>).allowAutomaticDescendantReorganization !== "boolean";
  }));
  const elevatedAgents = invalidPermissionShape ? [] : parsedPackage?.agents.filter((node) =>
    node.managementPermissions.allowAutomaticDescendantDeletion ||
    node.managementPermissions.allowAutomaticDescendantReorganization) ?? [];
  const sourceEngines = [...new Set(parsedPackage?.agents.map((node) => node.engine) ?? [])];
  const importAgents = useMutation({
    mutationFn: () => api.importAgents(projectId, {
      package: parsedPackage!, conversationId, engineMapping,
      ...(elevatedAgents.length > 0 ? { acknowledgeElevatedManagementPermissions: acknowledgeElevatedPermissions } : {}),
    }),
    onSuccess: (result) => {
      setImportJson("");
      setFileName(undefined);
      setEngineMapping({});
      setAcknowledgeElevatedPermissions(false);
      setError(undefined);
      void queryClient.invalidateQueries({ queryKey: ["agents", projectId] });
      onClose();
      onImported(result.rootAgentId);
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "Import failed"),
  });
  const loadFile = async (file: File) => {
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setError("This Agent package is larger than the 96 MiB import limit.");
      return;
    }
    try {
      setImportJson(await file.text());
      setFileName(file.name);
      setEngineMapping({});
      setAcknowledgeElevatedPermissions(false);
      setError(undefined);
    } catch {
      setError("Ponderosa could not read that file.");
    }
  };

  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
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
        <Typography variant="body2" color="text.secondary">{fileName ?? "Or paste JSON below"}</Typography>
      </Stack>
      <TextField
        label="Ponderosa JSON"
        value={importJson}
        onChange={(event) => { setImportJson(event.target.value); setFileName(undefined); setEngineMapping({}); setAcknowledgeElevatedPermissions(false); setError(undefined); }}
        multiline
        minRows={10}
        error={Boolean(importJson && !parsedPackage)}
        helperText={importJson && !parsedPackage
          ? "Choose or paste a ponderosa.agent-package.v1 document."
          : parsedPackage
            ? `${parsedPackage.agents.length} Agent${parsedPackage.agents.length === 1 ? "" : "s"} · ${parsedPackage.mode === "template" ? "template" : "full"}`
            : "Use a Full Agent, Full organization, Agent template, or Organization template export."}
      />
      <FormControl fullWidth>
        <InputLabel id="import-chat-label">Destination Project chat</InputLabel>
        <Select labelId="import-chat-label" label="Destination Project chat" value={conversationId} onChange={(event: SelectChangeEvent) => setConversationId(event.target.value)}>
          {conversations.map((conversation) => <MenuItem key={conversation.id} value={conversation.id}>{conversation.title}</MenuItem>)}
        </Select>
      </FormControl>
      {sourceEngines.map((source) => <FormControl key={source} fullWidth>
        <InputLabel id={`engine-map-${source}`}>Map {source}</InputLabel>
        <Select labelId={`engine-map-${source}`} label={`Map ${source}`} value={engineMapping[source] ?? ""} onChange={(event: SelectChangeEvent) => setEngineMapping((current) => ({ ...current, [source]: event.target.value }))}>
          {engines.map((engine) => <MenuItem key={engine.id} value={engine.id}>{engine.displayName}{engine.enabled === false ? " — disabled" : ""}</MenuItem>)}
        </Select>
      </FormControl>)}
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
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="contained" disabled={!parsedPackage || invalidPermissionShape || !conversationId || sourceEngines.some((source) => !engineMapping[source]) || (elevatedAgents.length > 0 && !acknowledgeElevatedPermissions) || importAgents.isPending} onClick={() => importAgents.mutate()}>
        {importAgents.isPending ? "Importing…" : "Import"}
      </Button>
    </DialogActions>
  </Dialog>;
}
