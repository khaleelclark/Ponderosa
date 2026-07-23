import { Avatar, Box, ButtonBase, Stack, Tooltip } from "@mui/material";
import { useState } from "react";
import type { ChatMessagePresentation } from "./contracts";
import { MessageSenderLabel } from "../MessageSenderLabel";
import { MessageActionsAndTimestamp, MessageTimestamp } from "../MessageTimestamp";
import { ChatOperatorLabel } from "./ChatOperatorLabel";

export function ChatMessageFrame({
  message,
  maxAgentWidth = 960,
}: {
  message: ChatMessagePresentation;
  maxAgentWidth?: number;
}): JSX.Element {
  const [mobileTimestampRevealed, setMobileTimestampRevealed] = useState(false);
  const author = message.author;
  const fromOperator = author.kind !== "agent";
  const operatorProfile = author.kind === "operator" ? author.profile : undefined;
  const senderName = author.kind === "operator"
    ? author.profile?.displayName ?? "You"
    : author.name ?? "Ponderosa";
  const openAuthor = author.kind === "agent" ? author.onOpen : undefined;
  const selectable = message.onSelect !== undefined;
  const selectMessage = () => {
    setMobileTimestampRevealed((current) => !current);
    message.onSelect?.();
  };
  const avatar = (
    <Avatar
      aria-label={`${senderName} avatar`}
      sx={{
        width: { xs: 32, sm: 36 },
        height: { xs: 32, sm: 36 },
        bgcolor: (theme) => theme.palette.mode === "dark" ? "#25302F" : "#F0F1EC",
        color: "text.primary",
        fontSize: { xs: 13, sm: 15 },
        fontWeight: 750,
      }}
    >
      {senderName.slice(0, 1).toLocaleUpperCase()}
    </Avatar>
  );

  return (
    <Box
      id={message.id}
      component="article"
      className="chat-message"
      aria-label={message.ariaLabel ?? `${senderName} message`}
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      onClick={selectMessage}
      onKeyDown={(event) => {
        if (!selectable || event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        selectMessage();
      }}
      sx={{
        alignSelf: "center",
        width: "min(1120px, 100%)",
        maxWidth: "100%",
        minWidth: 0,
        py: { xs: 0.75, sm: 1 },
        ...(selectable ? { cursor: "pointer" } : {}),
      }}
    >
      <Stack direction="row" spacing={{ xs: 1, sm: 1.5 }} sx={{ alignItems: "flex-start", justifyContent: fromOperator ? "flex-end" : "flex-start", minWidth: 0 }}>
        {!fromOperator ? openAuthor
          ? <Tooltip title={`Open ${senderName}`}><ButtonBase
              aria-label={`Open agent ${senderName} from profile image`}
              onClick={(event) => { event.stopPropagation(); openAuthor(); }}
              sx={{ borderRadius: "50%", flex: "0 0 auto" }}
            >{avatar}</ButtonBase></Tooltip>
          : avatar
        : null}
        <Box sx={{
          minWidth: 0,
          width: fromOperator ? "fit-content" : `min(100%, ${maxAgentWidth}px)`,
          maxWidth: fromOperator ? { xs: "94%", sm: "88%", md: "min(78%, 780px)" } : "100%",
        }}>
          {author.kind === "agent" ? (
            <Stack direction="row" spacing={0.75} sx={{ minHeight: 28, alignItems: "center", mb: 0.25 }}>
              {openAuthor ? <ButtonBase
                aria-label={`Open agent ${senderName} from name`}
                onClick={(event) => { event.stopPropagation(); openAuthor(); }}
                sx={{ borderRadius: 0.75, textAlign: "left", "& [data-message-sender]": { mb: 0, fontSize: 14 } }}
              ><MessageSenderLabel name={senderName} /></ButtonBase>
                : <Box sx={{ "& [data-message-sender]": { mb: 0, fontSize: 14 } }}><MessageSenderLabel name={senderName} /></Box>}
              <Box sx={{ color: "text.secondary" }}><MessageTimestamp value={message.createdAt} compact align="start" desktopOnly /></Box>
            </Stack>
          ) : author.kind === "operator" ? <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 0.25 }}><ChatOperatorLabel profile={operatorProfile} createdAt={message.createdAt} /></Box> : null}
          <Box
            data-message-bubble="true"
            sx={{
              width: fromOperator ? "fit-content" : "auto",
              maxWidth: "100%",
              ml: fromOperator ? "auto" : 0,
              px: fromOperator ? { xs: 1.25, sm: 1.5 } : 0,
              py: fromOperator ? { xs: 1, sm: 1.15 } : 0,
              borderRadius: 2,
              bgcolor: fromOperator ? (theme) => theme.palette.mode === "dark" ? "#27332F" : "#EFF0EB" : "transparent",
              color: "text.primary",
              border: 0,
              minWidth: 0,
            }}
          >
            {author.kind === "operator" ? <Box sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}><MessageSenderLabel name={senderName} /></Box> : null}
            {message.reply ? (
              <Box
                component="button"
                aria-label="Go to replied-to message"
                onClick={(event) => { event.stopPropagation(); message.reply?.onOpen(); }}
                sx={{ display: "block", width: "100%", mb: 0.75, p: 0.75, border: 0, borderLeft: 3, borderColor: "currentColor", bgcolor: "rgba(127,127,127,.14)", color: "inherit", textAlign: "left", cursor: "pointer", borderRadius: 1 }}
              >
                <Box component="span" sx={{ typography: "caption", display: "block", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{message.reply.text}</Box>
              </Box>
            ) : null}
            {message.body}
            {message.afterBody}
          </Box>
          {message.belowBody}
          <MessageActionsAndTimestamp
            mobileTimestampAlign={fromOperator ? "end" : "start"}
            mobileTimestampRevealed={mobileTimestampRevealed}
            showTimestamp={false}
            value={message.createdAt}
            status={message.status}
            actions={message.actions}
          />
        </Box>
      </Stack>
    </Box>
  );
}
