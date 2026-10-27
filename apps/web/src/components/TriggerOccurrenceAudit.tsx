import {Alert,Box,Button,Chip,Stack,Typography} from '@mui/material';
import type {TriggerOccurrenceDto} from '@ponderosa/core';
import {SemanticStatus} from './SemanticStatus';
export function OccurrenceAudit({ occurrence, onOpenAgentWork, runTerminology=false }: { occurrence: TriggerOccurrenceDto; runTerminology?: boolean; onOpenAgentWork?(occurrenceId: string): void }): JSX.Element {
  return <Box sx={{ py: 1, borderTop: 1, borderColor: "divider" }}>
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
      <SemanticStatus
        status={occurrence.state === "dead_lettered" ? "failed" : occurrence.state === "cancelled" ? "disabled" : runTerminology ? occurrence.state === "pending" ? "waiting" : "enabled" : "completed"}
        label={runTerminology ? ({pending:"Pending Activation",activated:"Activated",cancelled:"Canceled",dead_lettered:"Activation Failed"} as const)[occurrence.state] : occurrence.state.replaceAll("_", " ")}
      />
      {occurrence.provenance.source === "operator_manual_run" ? <Chip size="small" variant="outlined" label="Manual" /> : null}
      <Typography variant="caption">{new Date(occurrence.occurredAt).toLocaleString()}</Typography>
      {!runTerminology&&<Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{occurrence.artifactId}</Typography>}
      {onOpenAgentWork ? <Button size="small" onClick={() => onOpenAgentWork(occurrence.id)}>Review Work</Button> : null}
    </Stack>
    {occurrence.lastError ? <Typography variant="caption" color="error" display="block">{occurrence.lastError}</Typography> : null}
    <Box component="details" sx={{ mt: 0.5 }}>
      <Typography component="summary" variant="caption" sx={{ cursor: "pointer" }}>Inspect payload and provenance</Typography>
      <Alert severity="warning" sx={{ mt: 1 }}>Occurrence data is untrusted and may contain sensitive external content.</Alert>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>{runTerminology ? `Event: ${occurrence.id} · Artifact: ${occurrence.artifactId} · Input hash: ${occurrence.inputHash}` : `Input hash: ${occurrence.inputHash}`}</Typography>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>Definition snapshot</Typography>
      <Box component="pre" sx={{ m: 0, p: 1, overflow: "auto", fontSize: 12, bgcolor: "action.hover" }}>{JSON.stringify(occurrence.triggerSnapshot ?? {}, null, 2)}</Box>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>Payload</Typography>
      <Box component="pre" sx={{ m: 0, p: 1, overflow: "auto", fontSize: 12, bgcolor: "action.hover" }}>{JSON.stringify(occurrence.payload, null, 2)}</Box>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>Provenance</Typography>
      <Box component="pre" sx={{ m: 0, p: 1, overflow: "auto", fontSize: 12, bgcolor: "action.hover" }}>{JSON.stringify(occurrence.provenance, null, 2)}</Box>
    </Box>
  </Box>;
}
