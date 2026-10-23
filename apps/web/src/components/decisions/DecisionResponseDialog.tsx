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
import { useQuery } from "@tanstack/react-query";
import { decisionAnswersError } from "@ponderosa/core";
import { api } from "../../api";
import { queryKeys } from "../../queryKeys";
import { DecisionQuestionContent } from "./DecisionQuestionContent";
import { useEffect, useId, useRef, useState } from "react";
import type { DecisionPrompt, DecisionResponse } from "../../decisions";
import { validateDecisionResponse } from "../../decisions";
import { ComposerAttachment } from "../chat/ComposerAttachment";
import { filesFromClipboard } from "../chat/composerUtils";
import { collectAttachments, droppedAttachmentEntries } from "../chat/folderAttachments";
import { useDecisionAnswerDraft } from "./useDecisionAnswerDraft";
import { fileSelectionFingerprint } from "../../conversationRouting";

function DecisionAnswerDialog({
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
  const [activeQuestion, setActiveQuestion] = useState(0), [validationError, setValidationError] = useState<string>();
  const question = decision.questions?.[activeQuestion];
  const prompt = question ?? decision;
  const answer = question ? draft.answers?.find(item => item.questionId === question.id) : undefined;
  const text = question ? answer?.text ?? "" : draft.text;
  const setText = (text: string) => question ? draft.setAnswer({ questionId: question.id, status: "answered", text }) : draft.setText(text);
  const questionFiles = draft.attachments.files.flatMap((file, index) => !question || draft.questionByFile.get(file) === question.id ? [{ file, index }] : []);
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
      check(); draft.addFiles(result.files, question?.id);
      if (result.skipped) setFileError(`Skipped ${result.skipped} hidden, sensitive, or dependency items.`);
    } catch (error) { if (mounted.current) setFileError(error instanceof Error ? error.message : "The files could not be prepared."); }
    finally { importBusy.current = false; if (mounted.current) setPreparing(false); }
  };

  const submit = async () => {
    setValidationError(undefined);
    const response = validateDecisionResponse(decision, decision.questions ? { answers: draft.answers } : { text, attachmentIds: draft.attachmentIds });
    if (!response) {
      setValidationError("Answer or explicitly skip every question before submitting.");
      const missing = decision.questions?.findIndex(q => decisionAnswersError([q], draft.answers?.filter(a => a.questionId === q.id)));
      if (missing !== undefined && missing >= 0) setActiveQuestion(missing);
      return;
    }
    await onRespond(response);
  };

  return (
    <Dialog onClick={event => event.stopPropagation()} open={open} onClose={pending ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>{decision.mode === "text" ? "Answer Decision" : "Something Else"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {decision.questions && decision.questions.length > 1 ? <Stack spacing={0.5}>
            <Typography role="status">Question {activeQuestion + 1} of {decision.questions.length}</Typography>
            <Stack direction="row" spacing={0.5}>{decision.questions.map((item, index) => <Button key={item.id} size="small" disabled={pending}
              aria-label={`Go to question ${index + 1}`} aria-current={index === activeQuestion ? "step" : undefined} onClick={() => setActiveQuestion(index)}>{index + 1}</Button>)}</Stack>
          </Stack> : null}
          <DecisionQuestionContent question={prompt.question} context={prompt.context} projectId={decision.projectId} />
          {question ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            {question.options.map(option => <Button key={option.id} disabled={!draft.ready || pending || Boolean(questionFiles.length)}
              aria-pressed={answer?.optionId === option.id} variant={answer?.optionId === option.id ? "contained" : "outlined"} title={option.description}
              onClick={() => draft.setAnswer({ questionId: question.id, status: "answered", optionId: option.id })}>{option.label}</Button>)}
            <Button disabled={!draft.ready || pending || Boolean(questionFiles.length)} onClick={() => draft.setAnswer(answer?.status === "skipped"
              ? { questionId: question.id, status: "answered", text: "" } : { questionId: question.id, status: "skipped" })}>
              {answer?.status === "skipped" ? "Answer instead" : "Skip this question"}</Button>
            {answer?.status === "skipped" ? <Typography>No answer or approval will be supplied for this question.</Typography> : null}
          </Stack> : null}
          {draft.loadError ? <Alert severity="error" action={<Button onClick={draft.retry}>Retry</Button>}>{draft.loadError}</Alert> : null}
          {questionFiles.length ? <Typography variant="caption">Remove attached files before skipping or choosing an option.</Typography> : null}
          {answer?.status !== "skipped" ? <Box onDragOver={event => {
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
            label={prompt.mode === "text" ? "Your answer" : "Alternative direction"}
            disabled={!draft.ready || pending}
            helperText={draft.canAttach ? "Paste or drop images and files into your answer." : undefined}
            onPaste={event => {
              const files = filesFromClipboard(event.clipboardData.items, event.clipboardData.files);
              if (!files.length) return;
              event.preventDefault(); event.stopPropagation();
              if (canEdit.current && draft.canAttach) draft.addFiles(files, question?.id);
            }}
            value={text}
            onChange={(event) => setText(event.target.value)}
            inputProps={{ maxLength: 10_000 }}
          />
          <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1} sx={{ mt: 1 }}>
            {questionFiles.map(({file, index}) => <ComposerAttachment key={JSON.stringify(fileSelectionFingerprint([file]))} file={file}
              {...draft.uploads.uploadStates.get(file)} disabled={pending} onRetry={() => draft.uploads.retryUpload(file)} onRemove={() => draft.uploads.removeFile(index)} />)}
          </Stack>
          </Box> : null}
          {preparing ? <Typography role="status">Preparing files…</Typography> : null}
          {fileError || draft.attachments.error ? <Alert severity="error">{fileError || draft.attachments.error}</Alert> : null}
          {draft.saveError ? <Alert severity="warning" action={<Button onClick={draft.retry}>Retry draft save</Button>}>{draft.saveError}</Alert> : null}
          {validationError || error ? <Alert severity="error">{validationError || error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>Cancel</Button>
        {decision.questions && activeQuestion > 0 ? <Button disabled={pending} onClick={() => setActiveQuestion(index => index - 1)}>Back</Button> : null}
        {decision.questions && activeQuestion < decision.questions.length - 1
          ? <Button disabled={pending} onClick={() => setActiveQuestion(index => index + 1)}>Next</Button>
          : <Button variant="contained" disabled={pending || !draft.ready || preparing || !draft.uploadsComplete || (!decision.questions && !text.trim() && !draft.attachmentIds.length)} onClick={() => void submit()}>
              {pending ? "Sending…" : decision.questions ? "Submit answers" : "Send Response"}
            </Button>}

      </DialogActions>
    </Dialog>
  );
}

/** Notifications contain previews. Fetch the exact full record only when opened. */
export function DecisionResponseDialog(props: Parameters<typeof DecisionAnswerDialog>[0]): JSX.Element {
  const canonical = useQuery({ queryKey: [...queryKeys.decisions.all, "detail", props.decision.id],
    queryFn: async () => {
      const result = (await api.listDecisions({ id: props.decision.id }, AbortSignal.timeout(10_000))).find(item => item.id === props.decision.id);
      if (!result) throw new Error("This Decision is no longer available.");
      return result;
    }, enabled: props.open && props.decision.question === undefined, retry: false });
  const decision = props.decision.question !== undefined ? props.decision : canonical.data;
  if (decision && decision.status !== "pending") return <Dialog onClick={event => event.stopPropagation()} open={props.open} onClose={props.onClose} fullWidth maxWidth="sm" aria-label="Decision completed">
    <DialogTitle>Decision completed</DialogTitle><DialogContent><Alert severity="info">This Decision was answered or closed elsewhere. Your response will not replace it.</Alert></DialogContent>
    <DialogActions><Button onClick={props.onClose}>Close</Button></DialogActions></Dialog>;
  if (decision) return <DecisionAnswerDialog {...props} decision={decision} />;
  return <Dialog onClick={event => event.stopPropagation()} open={props.open} onClose={props.onClose} fullWidth maxWidth="sm" aria-label="Load Decision">
    <DialogTitle>Decision</DialogTitle><DialogContent>{canonical.error
      ? <Alert severity="error" action={<Button onClick={() => void canonical.refetch()}>Retry</Button>}>{canonical.error.message}</Alert>
      : <Typography role="status">Loading full question…</Typography>}</DialogContent><DialogActions><Button onClick={props.onClose}>Cancel</Button></DialogActions>
  </Dialog>;
}
