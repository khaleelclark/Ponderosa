import {Alert,Box,Button,Chip,Stack,Typography} from '@mui/material';
import type {TriggerOccurrenceDto} from '@ponderosa/core';
import {SemanticStatus} from './SemanticStatus';
const scheduleOutcomes={
  held:{status:"waiting",label:"Waiting For Current Run",branchLabel:"Waiting for current run"},
  steering:{status:"running",label:"Updating Current Run",branchLabel:"Updating current run"},
  updated:{status:"enabled",label:"Current Run Updated",branchLabel:"Updated current run"},
  run:{status:"enabled",label:"Run Created",branchLabel:"Run created"},
  unconfirmed:{status:"needs_attention",label:"Update Unconfirmed",branchLabel:"Update unconfirmed"},
  combined:{status:"disabled",label:"Combined Into Latest Check",branchLabel:"Combined with a later check"},
} as const;

export function OccurrenceAudit({ occurrence, onOpenAgentWork, runTerminology=false, onViewRun }: {
  occurrence: TriggerOccurrenceDto; runTerminology?: boolean; onOpenAgentWork?(occurrenceId: string): void; onViewRun?(executionId: string): void;
}): JSX.Element {
  const {schedule,branchExecutionId}=occurrence;
  const manual=occurrence.provenance.source==="operator_manual_run";
  const source=occurrence.triggerSnapshot?.sourceKind??(schedule?"schedule":occurrence.provenance.source);
  const sourceLabel=manual?"Manual":source==="schedule"?"Schedule":source==="webhook"?"Webhook":
    source==="filesystem"||source==="branch_filesystem"?"File change":"Trigger event";
  const canceledUpdate=runTerminology&&occurrence.state==="cancelled"&&schedule?.delivery==="unconfirmed"&&!schedule.reconciled;
  const delivery=schedule&&occurrence.state!=="dead_lettered"&&(occurrence.state!=="cancelled"||schedule.delivery==="combined"||canceledUpdate)
    ?scheduleOutcomes[schedule.delivery]:undefined;
  const branchLabel=canceledUpdate?"Canceled · update unconfirmed":delivery?.branchLabel??({
    pending:"Waiting to start",activated:branchExecutionId?"Run created":"Event accepted",cancelled:"Canceled",dead_lettered:"Run could not start",
  } as const)[occurrence.state];
  const time=new Date(occurrence.occurredAt).toLocaleString();
  const scheduleSummary=schedule&&<Typography variant="caption" color="text.secondary" display="block">First scheduled: {new Date(schedule.firstScheduledAt).toLocaleString()} · Latest scheduled: {new Date(schedule.lastScheduledAt).toLocaleString()} · {schedule.eventCountExact===false?'At least ':''}{schedule.eventCount} scheduled {schedule.eventCount===1?'event':'events'}</Typography>;
  return <Box component={runTerminology?"article":"div"} sx={{ py: 1, borderTop: 1, borderColor: "divider" }}>
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
      {runTerminology&&<>
        <Typography variant="body2" fontWeight={600}>{sourceLabel}</Typography>
        <Typography component="time" dateTime={occurrence.occurredAt} variant="caption">{time}</Typography>
      </>}
      <SemanticStatus
        status={delivery?.status??(occurrence.state === "dead_lettered" ? "failed" : occurrence.state === "cancelled" ? "disabled" : runTerminology ? occurrence.state === "pending" ? "waiting" : "enabled" : "completed")}
        label={runTerminology?branchLabel:delivery?.label??occurrence.state.replaceAll("_", " ")}
      />
      {schedule?.reconciled&&<Typography variant="caption">{schedule.reconciled==='applied'?'Update applied — confirmed by you':'Update not applied — reconciled by you'}</Typography>}
      {!runTerminology&&<>
        {schedule&&<Chip size="small" variant="outlined" label="Scheduled" />}
        {manual&&<Chip size="small" variant="outlined" label="Manual" />}
        <Typography variant="caption">{time}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{occurrence.artifactId}</Typography>
      </>}
      {onViewRun&&branchExecutionId&&<Button size="small" sx={{minHeight:44}} onClick={()=>onViewRun(branchExecutionId)}>View run</Button>}
      {onOpenAgentWork ? <Button size="small" onClick={() => onOpenAgentWork(occurrence.id)}>Review Work</Button> : null}
    </Stack>
    {!runTerminology&&scheduleSummary}
    {occurrence.lastError ? <Typography variant="caption" color="error" display="block" sx={runTerminology?{overflowWrap:"anywhere"}:undefined}>{occurrence.lastError}</Typography> : null}
    <Box component="details" sx={{ mt: 0.5 }}>
      <Typography component="summary" variant="caption" sx={{ cursor: "pointer" }}>Inspect payload and provenance</Typography>
      <Alert severity="warning" sx={{ mt: 1 }}>Occurrence data is untrusted and may contain sensitive external content.</Alert>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>{runTerminology ? `Event: ${occurrence.id} · Artifact: ${occurrence.artifactId} · Input hash: ${occurrence.inputHash}` : `Input hash: ${occurrence.inputHash}`}</Typography>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>Definition snapshot</Typography>
      <Box component="pre" sx={{ m: 0, p: 1, overflow: "auto", fontSize: 12, bgcolor: "action.hover" }}>{JSON.stringify(occurrence.triggerSnapshot ?? {}, null, 2)}</Box>
      {schedule ? <><Typography variant="caption" sx={{fontWeight:700}}>Schedule delivery</Typography>{runTerminology&&scheduleSummary}<Box component="pre" sx={{m:0,p:1,overflow:'auto',fontSize:12,bgcolor:'action.hover'}}>{JSON.stringify(schedule,null,2)}</Box></> : null}
      <Typography variant="caption" sx={{ fontWeight: 700 }}>Payload</Typography>
      <Box component="pre" sx={{ m: 0, p: 1, overflow: "auto", fontSize: 12, bgcolor: "action.hover" }}>{JSON.stringify(occurrence.payload, null, 2)}</Box>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>Provenance</Typography>
      <Box component="pre" sx={{ m: 0, p: 1, overflow: "auto", fontSize: 12, bgcolor: "action.hover" }}>{JSON.stringify(occurrence.provenance, null, 2)}</Box>
    </Box>
  </Box>;
}
