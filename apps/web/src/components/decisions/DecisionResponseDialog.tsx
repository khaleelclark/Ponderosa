import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useId, useRef, useState } from "react";
import type { DecisionPrompt, DecisionResponse } from "../../decisions";
import { validateDecisionResponse } from "../../decisions";
import { ComposerAttachment } from "../chat/ComposerAttachment";
import { filesFromClipboard } from "../chat/composerUtils";
import { collectAttachments, droppedAttachmentEntries } from "../chat/folderAttachments";
import { useDecisionAnswerDraft } from "./useDecisionAnswerDraft";
import { fileSelectionFingerprint } from "../../conversationRouting";

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
  const draft = useDecisionAnswerDraft(decision, open);
  const { text, setText } = draft;
  const [preparing, setPreparing] = useState(false), [fileError, setFileError] = useState<string>();
  const mounted = useRef(true), canEdit = useRef(false), importBusy = useRef(false);
  canEdit.current = draft.ready && !pending;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const importFiles = async (entries: Array<FileSystemEntry | File>) => {
    if (!canEdit.current || !draft.canAttach || importBusy.current) return;
    importBusy.current = true;
    setPreparing(true); setFileError(undefined);
    const check = () => { if (!mounted.current || !canEdit.current) throw new Error("File preparation stopped because this answer is no longer editable."); };
    try {
      const remaining = draft.limits.maxMessageBytes - draft.attachments.files.reduce((sum, file) => sum + file.size, 0);
      const result = await collectAttachments(entries, Math.min(draft.limits.maxFileBytes, remaining), check);
      check(); draft.uploads.addFiles(result.files);
      if (result.skipped) setFileError(`Skipped ${result.skipped} hidden, sensitive, or dependency items.`);
    } catch (error) { if (mounted.current) setFileError(error instanceof Error ? error.message : "The files could not be prepared."); }
    finally { importBusy.current = false; if (mounted.current) setPreparing(false); }
  };

  const submit = async () => {
    const response = validateDecisionResponse(decision, { text, attachmentIds: draft.attachmentIds });
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
          {draft.loadError ? <Alert severity="error" action={<Button onClick={draft.retry}>Retry</Button>}>{draft.loadError}</Alert> : null}
          <Box onDragOver={event => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = canEdit.current && draft.canAttach ? "copy" : "none";
          }} onDrop={event => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault(); event.stopPropagation();
            void importFiles(droppedAttachmentEntries(event.dataTransfer));
          }}>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label={decision.mode === "text" ? "Your answer" : "Alternative direction"}
            disabled={!draft.ready || pending}
            helperText={draft.canAttach ? "Paste or drop images and files into your answer." : undefined}
            onPaste={event => {
              const files = filesFromClipboard(event.clipboardData.items, event.clipboardData.files);
              if (!files.length) return;
              event.preventDefault(); event.stopPropagation();
              if (canEdit.current && draft.canAttach) draft.uploads.addFiles(files);
            }}
            value={text}
            onChange={(event) => setText(event.target.value)}
            inputProps={{ maxLength: 10_000 }}
          />
          <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1} sx={{ mt: 1 }}>
            {draft.attachments.files.map((file, index) => <ComposerAttachment key={JSON.stringify(fileSelectionFingerprint([file]))} file={file}
              {...draft.uploads.uploadStates.get(file)} disabled={pending} onRetry={() => draft.uploads.retryUpload(file)} onRemove={() => draft.uploads.removeFile(index)} />)}
          </Stack>
          </Box>
          {preparing ? <Typography role="status">Preparing files…</Typography> : null}
          {fileError || draft.attachments.error ? <Alert severity="error">{fileError || draft.attachments.error}</Alert> : null}
          {draft.saveError ? <Alert severity="warning" action={<Button onClick={draft.retry}>Retry draft save</Button>}>{draft.saveError}</Alert> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>Cancel</Button>
        <Button variant="contained" disabled={pending || !draft.ready || preparing || !draft.uploadsComplete || (!text.trim() && !draft.attachmentIds.length)} onClick={() => void submit()}>
          {pending ? "Sending…" : "Send Response"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
