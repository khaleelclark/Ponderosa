import { Box, Paper, Stack, Typography } from "@mui/material";
import type { DecisionPrompt } from "../../decisions";
import { DecisionActions } from "./DecisionActions";

export function DecisionCard({
  decision,
  title,
  context,
  onResolved,
}: {
  decision: DecisionPrompt;
  title?: string;
  context?: string;
  onResolved?(): void;
}): JSX.Element {
  return (
    <Paper variant="outlined" component="section" aria-label="Decision" sx={{ p: 1.5 }}>
      <Stack spacing={1.25}>
        <Box>
          <Typography fontWeight={850}>{title ?? decision.question ?? "Decision"}</Typography>
          {context ?? decision.context ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{context ?? decision.context}</Typography> : null}
        </Box>
        <DecisionActions decision={decision} onResolved={onResolved} />
      </Stack>
    </Paper>
  );
}
