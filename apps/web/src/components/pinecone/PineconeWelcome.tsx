import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import { CAPABILITY_IDS } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { requestJson } from "../../api/real";
import { usePineconeProfile } from "../../hooks/queries";
import { CapabilityPolicyEditor, type CapabilityPolicyResponse } from "../CapabilityPolicyEditor";
import { PineconeMark } from "./PineconeMark";

/** Opening or saving setup never authors Communication or starts work. */
export function PineconeWelcome({ agentId, title, empty }: {
  agentId: string; title: string; empty: boolean;
}): JSX.Element | null {
  const profile = usePineconeProfile(agentId);
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/capabilities`;
  const policy = useQuery({ queryKey: ["capability-policy", endpoint],
    queryFn: () => requestJson<CapabilityPolicyResponse>(endpoint), enabled: Boolean(profile.data) });
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => { setOpen(false); setDirty(false); setConfirmDiscard(false) }, [agentId]);
  if (!profile.data) return null;
  const close = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else setOpen(false);
  };
  const restricted = policy.data?.effective.restrictedCapabilityIds.includes(CAPABILITY_IDS.managedAgentCreate);
  return <>
    <Alert role="note" severity="info" icon={<PineconeMark aria-hidden="true" />} sx={{ m: 1, flexShrink: 0 }}>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">{title} · Private Agent chat</Typography>
        {empty ? <Typography variant="body2">
          Tell me what you want to work on and which sources to use. For example: “Help me plan this week. Ask me what matters first.”
        </Typography> : null}
        <Typography variant="body2">Work progresses while your host and Ponderosa are online. This Agent has host authority under your existing settings. Private messages are scoped to participants; authorized host operators can access them.</Typography>
        <Typography variant="body2" role="status">{policy.isPending ? "Loading helper policy…" : policy.error ? "Helper policy could not be loaded." : restricted ? "Managed helper creation is restricted by current policy." : "Managed helper creation is allowed by current policy."}</Typography>
        <Button sx={{ minHeight: 44, alignSelf: "flex-start" }} onClick={() => setOpen(true)}>Helper settings</Button>
      </Stack>
    </Alert>
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby="pinecone-helper-title">
      <DialogTitle id="pinecone-helper-title">Managed helpers</DialogTitle>
      <DialogContent>
        <CapabilityPolicyEditor endpoint={endpoint} scopeKind="agent" title="Helper creation"
          description="New Pinecones start with managed helper creation restricted. Existing Agents retain their current policy. Broader restrictions remain in effect. Allow and Save to enable future helper work; saving creates no helper."
          savedNotice="Restrictions apply to new helper creation calls. Enabling helpers takes effect for a later Run that admits the tool. Existing helpers continue."
          onDirtyChange={setDirty} onSavingChange={setSaving} />
      </DialogContent>
      <DialogActions><Button disabled={saving} onClick={close}>Close</Button></DialogActions>
    </Dialog>
    <Dialog open={confirmDiscard} onClose={() => setConfirmDiscard(false)} aria-labelledby="pinecone-helper-discard">
      <DialogTitle id="pinecone-helper-discard">Discard unsaved helper settings?</DialogTitle>
      <DialogActions>
        <Button onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
        <Button onClick={() => { setConfirmDiscard(false); setOpen(false) }}>Discard changes</Button>
      </DialogActions>
    </Dialog>
  </>;
}
