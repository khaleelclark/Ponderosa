import { Alert, Button, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { NativeRuntimeControlBoundary, NativeRuntimeControlRequest, RuntimeCommandResult } from "@ponderosa/core";
import { requestJson } from "../api/real";

export function NativeRuntimeControls({agentId, savedModel}: {agentId: string; savedModel?: string}): JSX.Element {
  const [mode, setMode] = useState("default");
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/native-controls`;
  const load = useMutation({ mutationFn: () => requestJson<NativeRuntimeControlBoundary>(endpoint, {cache:"no-store"}), retry: false });
  const apply = useMutation({ mutationFn: (operation: "model" | "permission-mode") => {
    if (!load.data) throw new Error("Load the current native controls first");
    const {sessionId, runId, fencingToken} = load.data;
    const body: NativeRuntimeControlRequest = {sessionId, runId, fencingToken, operation, value: operation === "model" ? savedModel ?? "" : mode};
    return requestJson<RuntimeCommandResult>(endpoint, {method:"POST", body:JSON.stringify(body)});
  }, retry:false, onSettled: () => { load.reset(); } });
  return <Paper variant="outlined" sx={{p:2}}><Stack spacing={1.5}>
    <Typography variant="subtitle1" fontWeight={800}>Native Runtime Controls</Typography>
    <Typography variant="body2" color="text.secondary">Applies to this retained runtime; saved tool restrictions remain.</Typography>
    <Button onClick={() => { apply.reset(); load.mutate(); }} disabled={load.isPending || apply.isPending}>Load Current Controls</Button>
    {load.data?.operations.includes("model") && savedModel ? <Button disabled={apply.isPending} onClick={() => apply.mutate("model")}>Apply Saved Model To Idle Runtime</Button> : null}
    {load.data?.operations.includes("permission-mode") ? <>
      <TextField select label="New Native Permission Mode" value={mode} onChange={event => setMode(event.target.value)} disabled={apply.isPending}>
        <MenuItem value="default">Ask when required</MenuItem><MenuItem value="acceptEdits">Allow native file edits</MenuItem>
        <MenuItem value="plan">Plan mode</MenuItem><MenuItem value="auto">Native automatic review</MenuItem><MenuItem value="dontAsk">Deny requests that require permission</MenuItem>
        <MenuItem value="bypassPermissions">Bypass native permission prompts</MenuItem>
      </TextField>
      <Button onClick={() => apply.mutate("permission-mode")} disabled={apply.isPending}>Apply Permission Mode</Button>
    </> : null}
    {load.data && load.data.operations.length === 0 ? <Typography>No live controls are available for this runtime.</Typography> : null}
    {load.error || apply.error ? <Alert severity="warning">{(load.error ?? apply.error) instanceof Error ? (load.error ?? apply.error)!.message : "Native control unavailable"}</Alert> : null}
    {apply.data ? <Alert severity="info">{apply.data.message ?? "Native control acknowledged."}</Alert> : null}
  </Stack></Paper>;
}
