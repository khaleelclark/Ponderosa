import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useId, useState } from "react";
import type { DecisionPrompt, DecisionResponse } from "../../decisions";
import { validateDecisionResponse } from "../../decisions";

export function DecisionResponseDialog({
  decision,
  open,
  pending,
  error,
  onClose,
  onRespond,
}: {
  decision: DecisionPrompt;
  open: boolean;
  pending?: boolean;
  error?: string;
  onClose(): void;
  onRespond(response: DecisionResponse): Promise<unknown> | unknown;
}): JSX.Element {
  const titleId = useId();
  const [text, setText] = useState("");

  useEffect(() => {
    if (!open) setText("");
  }, [open]);

  const submit = async () => {
    const response = validateDecisionResponse(decision, { text });
    if (!response) return;
    await onRespond(response);
  };

  return (
    <Dialog open={open} onClose={pending ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>{decision.mode === "text" ? "Answer Decision" : "Something Else"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <div>
            <Typography fontWeight={800}>{decision.question ?? "What should the Agent do?"}</Typography>
            {decision.context ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, whiteSpace: "pre-wrap" }}>{decision.context}</Typography> : null}
          </div>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label={decision.mode === "text" ? "Your answer" : "Alternative direction"}
            value={text}
            onChange={(event) => setText(event.target.value)}
            inputProps={{ maxLength: 10_000 }}
          />
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>Cancel</Button>
        <Button variant="contained" disabled={pending || !text.trim()} onClick={() => void submit()}>
          {pending ? "Sending…" : "Send Response"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
