import { Box, Paper, Stack, Typography } from "@mui/material";
import type { DecisionPrompt } from "../../decisions";
import { DecisionQuestionContent } from "./DecisionQuestionContent";
import { DecisionActions } from "./DecisionActions";

export function DecisionCard({
  decision,
  title,
  context,
  onResolved,
  onRetentionChange,
}: {
  decision: DecisionPrompt;
  title?: string;
  context?: string;
  onResolved?(): void;
  onRetentionChange?(decision: DecisionPrompt, retain: boolean): void;
}): JSX.Element {
  return (
    <Paper variant="outlined" component="section" aria-label="Decision" sx={{ p: 1.5 }}>
      <Stack spacing={1.25}>
        <Box>
          {decision.questions ? decision.questions.map((question, index) => <Box key={question.id} sx={{ mt: index ? 2 : 0 }}>
            {decision.questions!.length > 1 ? <Typography variant="caption">Question {index + 1} of {decision.questions!.length}</Typography> : null}
            <DecisionQuestionContent {...question} projectId={decision.projectId} />
          </Box>) : <DecisionQuestionContent question={title ?? decision.question ?? "Decision"} context={context ?? decision.context} projectId={decision.projectId} />}
        </Box>
        <DecisionActions decision={decision} onResolved={onResolved} onRetentionChange={onRetentionChange} />
      </Stack>
    </Paper>
  );
}
