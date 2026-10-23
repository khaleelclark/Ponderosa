import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import type { ConversationDecisionEventDto, OperatorProfileDto } from "@ponderosa/core";
import { useId, useState } from "react";
import { ChatMessageFrame } from "../chat/ChatMessageFrame";
import { AgentMention } from "../chat/ChatMessages";
import { DecisionQuestionContent } from "./DecisionQuestionContent";
import { ChatAttachments } from "../chat/ChatAttachments";
import { decisionResponseChoice, decisionResponseSummary, decisionResponseVerb } from "./decisionResponse";

/** Presentation of one canonical answer, shared by every human-facing timeline. */
export function DecisionResponseMessage({ event, operatorProfile, onOpenAgent }: {
  event: ConversationDecisionEventDto;
  operatorProfile?: OperatorProfileDto;
  onOpenAgent?(agentId: string): void;
}): JSX.Element {
  const [questionOpen, setQuestionOpen] = useState(false);
  const titleId = useId();
  const questionId = useId();
  const decision = event.decision;
  const automatic = decision.response?.optionId === "auto_allowed";
  const choice = decisionResponseChoice(decision);
  // Reject stale/mismatched presentation metadata rather than opening a different Agent.
  const recipient = event.recipientAgent?.id === decision.agentId ? event.recipientAgent : undefined;
  const label = recipient ? `#${recipient.handle}` : event.recipientAgent === null ? "Deleted Agent" : "Agent unavailable";
  const summary = automatic ? choice : decisionResponseSummary(decision, choice, label);
  return <>
    <ChatMessageFrame message={{ id: event.id, createdAt: event.createdAt,
      author: automatic ? { kind: "notice" } : { kind: "operator", profile: operatorProfile }, ariaLabel: summary,
      body: <Box sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
          {automatic ? choice : <>{decisionResponseVerb(decision)} {recipient
            ? <AgentMention agentId={decision.agentId} label={recipient.handle} onOpenAgent={onOpenAgent} />
            : label}: {choice}</>}
        </Typography>
        {decision.response?.answers ? decision.questions?.map((question, index) => {
          const answer = decision.response!.answers!.find(item => item.questionId === question.id);
          return <Box key={question.id} sx={{ mt: 1 }}>
            <Typography variant="caption">Question {index + 1} · {question.id}</Typography>
            <Typography sx={{ whiteSpace: "pre-wrap" }}>{answer?.status === "skipped" ? "Skipped — no answer or approval supplied" :
              question.options.find(option => option.id === answer?.optionId)?.label ?? answer?.text ?? (answer?.attachmentIds?.length ? "Attached evidence" : "Response unavailable")}</Typography>
            {answer?.attachmentIds?.length ? <ChatAttachments attachments={decision.response!.attachments?.filter(file => answer.attachmentIds!.includes(file.id)) ?? []} /> : null}
          </Box>;
        }) : decision.response?.attachments?.length ? <ChatAttachments attachments={decision.response.attachments} /> : null}
        {!automatic ? <Button className="chat-text-navigation" size="small" aria-haspopup="dialog" aria-controls={questionOpen ? questionId : undefined}
          onClick={() => setQuestionOpen(true)} sx={{ mt: .25 }}>View question</Button> : null}
      </Box> }} />
    <Dialog onClick={event => event.stopPropagation()} id={questionId} open={questionOpen} onClose={() => setQuestionOpen(false)} aria-labelledby={titleId}
      fullWidth maxWidth="sm" data-decision-id={decision.id}>
      <DialogTitle id={titleId}>Original question</DialogTitle>
      <DialogContent data-decision-id={decision.id} sx={{ overflowWrap: "anywhere" }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>From {label}</Typography>
        {(decision.questions ?? [{ id: decision.id, question: decision.question, context: decision.context, options: decision.options }]).map((question, index) => <Box key={question.id} sx={{ mt: index ? 2 : 0 }}>
          {decision.questions && decision.questions.length > 1 ? <Typography variant="caption">Question {index + 1}</Typography> : null}
          <DecisionQuestionContent {...question} projectId={decision.projectId} />
        </Box>)}
      </DialogContent>
      <DialogActions><Button onClick={() => setQuestionOpen(false)}>Close question</Button></DialogActions>
    </Dialog>
  </>;
}
