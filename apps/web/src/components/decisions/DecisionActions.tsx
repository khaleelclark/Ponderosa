import {MutationErrorDetails} from "../MutationNotifications";
import { Button, Stack } from "@mui/material";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DecisionPrompt, DecisionResponse } from "../../decisions";
import { decisionAcceptsText, decisionTextActionLabel } from "../../decisions";
import { useDecisionResponse } from "../../hooks/useDecisionResponse";
import { DecisionResponseDialog } from "./DecisionResponseDialog";
import { RuntimeElicitationActions } from "./RuntimeElicitationActions";
import { settleDecisionResponse } from "./decisionResponse";

export function DecisionActions({
  decision,
  onResolved,
  onRetentionChange,
  inline,
  children,
  onOpen,
  onDismiss,
}: {
  decision: DecisionPrompt;
  compact?: boolean;
  onResolved?(): void;
  onRetentionChange?(decision: DecisionPrompt, retain: boolean): void;
  inline?: boolean;
  children?: ReactNode;
  onOpen?(): void;
  onDismiss?(): void;
}): JSX.Element | null {
  const [textDialogOpen, setTextDialogOpen] = useState(false);
  const answerTrigger = useRef<HTMLButtonElement>(null), wasEditing = useRef(false);
  useEffect(() => {
    if (inline && wasEditing.current && !textDialogOpen && answerTrigger.current?.getClientRects().length)
      answerTrigger.current.focus({ preventScroll: true });
    wasEditing.current = textDialogOpen;
  }, [inline, textDialogOpen]);
  const response = useDecisionResponse(() => {
    setTextDialogOpen(false);
    onResolved?.();
  });
  // A canonical approval record alone cannot confirm that access/form/action
  // completion succeeded. Keep its existing idempotent retry reachable.
  const currentAttempt = response.variables?.decision.id === decision.id;
  const unconfirmedApproval = currentAttempt && response.isError && (decision.mode === "approval" || decision.approvalScope || decision.runtimeAction);
  useEffect(() => {
    // A canonical approval can resolve before applying access succeeds. Keep
    // that exact mounted response owner available until its existing retry settles.
    if (textDialogOpen || currentAttempt) onRetentionChange?.(decision, textDialogOpen || response.isPending || Boolean(unconfirmedApproval));
  }, [currentAttempt, decision, onRetentionChange, response.isPending, textDialogOpen, unconfirmedApproval]);
  if (response.isSuccess && response.data.id === decision.id && response.data.status !== "pending") return children ? <>{children}</> : null;
  if (decision.status !== "pending" && !(currentAttempt && response.isPending) && !unconfirmedApproval) return children ? <>{children}</> : null;
  if (onOpen) return <>{children}<Button size="small" onClick={event => { event.stopPropagation(); onOpen(); }}>Answer Question</Button></>;

  const respond = (value: DecisionResponse) => {
    onRetentionChange?.(decision, true);
    return settleDecisionResponse(() => response.mutateAsync({ decision, response: value }));
  };
  const error = response.error instanceof Error
    ? response.error.message
    : response.isError
      ? "The Decision response could not be sent."
      : undefined;
  const grouped = Boolean(decision.questions || decision.questionCount);
  const skipButton = <Button size="small" color="inherit" disabled={response.isPending}
    onClick={(event) => { event.stopPropagation(); void respond({ skip: true }); }}>
    Skip Question
  </Button>;
  if (decision.runtimeAction) {
    return (
      <>{children}<RuntimeElicitationActions
        decision={decision}
        pending={response.isPending}
        error={error}
        onRespond={respond}
      />{skipButton}</>
    );
  }

  return (
    <>
      {!inline || !textDialogOpen ? children : null}
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ display: inline && textDialogOpen ? 'none' : undefined }}>
        {!grouped && decision.options.map((option) => (
          <Button
            key={option.id}
            size="small"
            variant="outlined"
            disabled={response.isPending}
            title={option.description}
            onClick={(event) => {
              event.stopPropagation();
              void respond({ optionId: option.id });
            }}
          >
            {option.label}
          </Button>
        ))}
        {decisionAcceptsText(decision) && !(inline && textDialogOpen) ? (
          <Button
            ref={answerTrigger}
            size="small"
            variant="outlined"
            disabled={response.isPending}
            onClick={(event) => {
              event.stopPropagation();
              onRetentionChange?.(decision, true);
              setTextDialogOpen(true);
            }}
          >
            {decisionTextActionLabel(decision)}
          </Button>
        ) : null}
        {!grouped && skipButton}
      </Stack>
      {!textDialogOpen&&<MutationErrorDetails title="Decision Response Needs Review" error={error}/>}
      <DecisionResponseDialog
        key={decision.id}
        decision={decision}
        inline={inline}
        open={textDialogOpen}
        pending={response.isPending}
        error={error}
        onClose={() => {
          if (inline && onDismiss) { onDismiss(); return; }
          setTextDialogOpen(false); if (!response.isPending && !unconfirmedApproval) onRetentionChange?.(decision, false);
        }}
        onCompleted={() => {
          if (response.isPending || unconfirmedApproval) return;
          setTextDialogOpen(false); onRetentionChange?.(decision, false);
        }}
        onRespond={respond}
      />
    </>
  );
}
