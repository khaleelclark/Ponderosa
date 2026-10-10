import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from "@mui/material";
import { useEffect, useState } from "react";
import { usePineconeProfile } from "../../hooks/queries";
import { CapabilityPolicyEditor } from "../CapabilityPolicyEditor";

/** Opening or saving setup never authors Communication or starts work. */
export function PineconeHelperSettings({ agentId }: {
  agentId: string;
}): JSX.Element | null {
  const profile = usePineconeProfile(agentId);
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/capabilities`;
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
  return <>
    <Button variant="outlined" sx={{ minHeight: 44, alignSelf: "flex-start" }} onClick={() => setOpen(true)}>Helper settings</Button>
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
