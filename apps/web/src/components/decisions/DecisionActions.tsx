import { Alert, Button, Stack } from "@mui/material";
import { useState } from "react";
import type { DecisionPrompt, DecisionResponse } from "../../decisions";
import { decisionAcceptsText, decisionTextActionLabel } from "../../decisions";
import { useDecisionResponse } from "../../hooks/useDecisionResponse";
import { DecisionResponseDialog } from "./DecisionResponseDialog";
import { RuntimeElicitationActions } from "./RuntimeElicitationActions";
import { settleDecisionResponse } from "./decisionResponse";

export function DecisionActions({
  decision,
  compact = false,
  onResolved,
}: {
  decision: DecisionPrompt;
  compact?: boolean;
  onResolved?(): void;
}): JSX.Element | null {
  const [textDialogOpen, setTextDialogOpen] = useState(false);
  const response = useDecisionResponse(() => {
    setTextDialogOpen(false);
    onResolved?.();
  });
  // A canonical approval record alone cannot confirm that access/form/action
  // completion succeeded. Keep its existing idempotent retry reachable.
  const currentAttempt = response.variables?.decision.id === decision.id;
  const unconfirmedApproval = currentAttempt && response.isError && (decision.mode === "approval" || decision.approvalScope || decision.runtimeAction);
  if (response.isSuccess && response.data.id === decision.id && response.data.status !== "pending") return null;
  if (decision.status !== "pending" && !(currentAttempt && response.isPending) && !unconfirmedApproval) return null;

  const respond = (value: DecisionResponse) => settleDecisionResponse(() =>
    response.mutateAsync({ decision, response: value })
  );
  const error = response.error instanceof Error
    ? response.error.message
    : response.isError
      ? "The Decision response could not be sent."
      : undefined;
  const grouped = Boolean(decision.questions || decision.questionCount);
  const skipButton = <Button size="small" color="inherit" disabled={response.isPending}
    onClick={(event) => { event.stopPropagation(); void respond({ skip: true }); }}>
    Skip question
  </Button>;
  if (decision.runtimeAction) {
    return (
      <><RuntimeElicitationActions
        decision={decision}
        pending={response.isPending}
        error={error}
        onRespond={respond}
      />{skipButton}</>
    );
  }

  return (
    <>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
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
        {decisionAcceptsText(decision) ? (
          <Button
            size="small"
            variant="outlined"
            disabled={response.isPending}
            onClick={(event) => {
              event.stopPropagation();
              setTextDialogOpen(true);
            }}
          >
            {decisionTextActionLabel(decision)}
          </Button>
        ) : null}
        {!grouped && skipButton}
      </Stack>
      {error ? (
        <Alert severity="error" sx={compact ? { mt: 0.75 } : undefined}>
          {error}
        </Alert>
      ) : null}
      <DecisionResponseDialog
        key={decision.id}
        decision={decision}
        open={textDialogOpen}
        pending={response.isPending}
        error={error}
        onClose={() => setTextDialogOpen(false)}
        onRespond={respond}
      />
    </>
  );
}
