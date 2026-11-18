import { Box, Typography } from "@mui/material";
import type { DecisionOptionDto } from "@ponderosa/core";
import { ChatMessageBody } from "../chat/ChatMessages";

/** Full canonical question prose; the containing conversation/dialog owns scroll. */
export function DecisionQuestionContent({ question, context, options, projectId }: {
  question?: string; context?: string; options?: DecisionOptionDto[]; projectId?: string;
}): JSX.Element {
  return <Box sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <ChatMessageBody text={question ?? "What should the Agent do?"} collapseLongMessage={false} compactMarkdown projectId={projectId} />
    {context ? <ChatMessageBody text={context} collapseLongMessage={false} compactMarkdown smallText projectId={projectId} /> : null}
    {options?.map(option => <Box key={option.id} sx={{ mt: 1 }}><Typography variant="body2" fontWeight={700}>{option.label}</Typography>
      {option.description ? <Typography variant="body2">{option.description}</Typography> : null}</Box>)}
  </Box>;
}
