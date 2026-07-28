import { Alert, Button, Stack } from "@mui/material";
import { useState } from "react";
import type { DecisionPrompt, DecisionResponse } from "../../decisions";
import { decisionAcceptsText, decisionTextActionLabel } from "../../decisions";
import { useDecisionResponse } from "../../hooks/useDecisionResponse";
import { DecisionResponseDialog } from "./DecisionResponseDialog";
import { RuntimeElicitationActions } from "./RuntimeElicitationActions";

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
  if (decision.status !== "pending") return null;

  const respond = (value: DecisionResponse) =>
    response.mutateAsync({ decisionId: decision.id, response: value });
  const error = response.error instanceof Error
    ? response.error.message
    : response.isError
      ? "The Decision response could not be sent."
      : undefined;
  if (decision.runtimeAction) {
    return (
      <RuntimeElicitationActions
        decision={decision}
        pending={response.isPending}
        error={error}
        onRespond={respond}
      />
    );
  }

  return (
    <>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        {decision.options.map((option) => (
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
      </Stack>
      {!compact && error ? <Alert severity="error">{error}</Alert> : null}
      <DecisionResponseDialog
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
