import { Avatar, Box, ButtonBase, Stack, Tooltip } from "@mui/material";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { ChatMessagePresentation } from "./contracts";
import { MessageSenderLabel } from "../MessageSenderLabel";
import { MessageActionsAndTimestamp, MessageTimestamp } from "../MessageTimestamp";
import { ChatAttachments } from "./ChatAttachments";
import { ChatOperatorLabel } from "./ChatOperatorLabel";
import {
  messageSelectionIntersectsCurrentTarget,
  messageSelectionTargetIsInteractive,
} from "./messageSelection";
import { observeNotificationVisibility } from "../../notificationVisibility";

export function ChatMessageFrame({
  message,
  maxAgentWidth = 960,
}: {
  message: ChatMessagePresentation;
  maxAgentWidth?: number;
}): JSX.Element {
  const [mobileTimestampRevealed, setMobileTimestampRevealed] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const author = message.author;
  const fromOperator = author.kind !== "agent";
  const operatorProfile = author.kind === "operator" ? author.profile : undefined;
  const senderName = author.kind === "operator"
    ? author.profile?.displayName ?? "You"
    : author.name ?? "Ponderosa";
  const openAuthor =
    author.kind === "agent" || author.kind === "inbound_agent"
      ? author.onOpen
      : undefined;
  const selectable = message.onSelect !== undefined;
  const selectMessage = () => {
    setMobileTimestampRevealed((current) => !current);
    message.onSelect?.();
  };
  const toggleTimestamp = (event: ReactMouseEvent<HTMLElement>) => {
    // Interactive descendants own their clicks; tapping message content on a
    // phone is the timestamp affordance.
    if (messageSelectionTargetIsInteractive(event.target, event.currentTarget)) return;
    setMobileTimestampRevealed((current) => !current);
  };
  useEffect(() => {
    const element = articleRef.current;
    if (!element || !message.onVisible || typeof IntersectionObserver === "undefined") return;
    let intersecting = false;
    const report = () =>
      message.onVisible?.(
        intersecting && document.visibilityState === "visible" && document.hasFocus(),
      );
    const stopObserving = observeNotificationVisibility(element, visible => {
      intersecting = visible;
      report();
    });
    const onVisibilityChange = () => report();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);
    window.addEventListener("blur", onVisibilityChange);
    return () => {
      message.onVisible?.(false);
      stopObserving();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
      window.removeEventListener("blur", onVisibilityChange);
    };
  }, [message.id, message.onVisible]);
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
      ref={articleRef}
      id={message.id}
      component="article"
      className="chat-message"
      aria-label={message.ariaLabel ?? `${senderName} message`}
      onClick={selectable
        ? event => {
            if (!messageSelectionTargetIsInteractive(event.target, event.currentTarget) &&
                !messageSelectionIntersectsCurrentTarget(event.currentTarget)) {
              selectMessage();
            }
          }
        : toggleTimestamp}
      sx={{
        alignSelf: "center",
        width: "min(1120px, 100%)",
        maxWidth: "100%",
        minWidth: 0,
        py: { xs: 0.75, sm: 1 },
        ...(selectable ? { cursor: "pointer" } : {}),
      }}
    >
      {message.beforeHeader ? (
        <Box sx={{ minWidth: 0, pl: { xs: 5, sm: 6.5 } }}>
          {message.beforeHeader}
        </Box>
      ) : null}
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
                sx={{ minHeight: 28, borderRadius: 0.75, textAlign: "left", "& [data-message-sender]": { mb: 0, fontSize: 14 } }}
              ><MessageSenderLabel name={senderName} /></ButtonBase>
                : <Box sx={{ "& [data-message-sender]": { mb: 0, fontSize: 14 } }}><MessageSenderLabel name={senderName} /></Box>}
              {message.source}
              <Box sx={{ color: "text.secondary" }}><MessageTimestamp value={message.createdAt} align="start" desktopOnly /></Box>
            </Stack>
          ) : author.kind === "operator" ? (
            <Stack
              direction="row"
              spacing={0.75}
              sx={{ justifyContent: "flex-end", alignItems: "center", mb: 0.25 }}
            >
              {message.source}
              <ChatOperatorLabel profile={operatorProfile} createdAt={message.createdAt} />
            </Stack>
          ) : author.kind === "inbound_agent" ? (
            <Stack
              direction="row"
              spacing={0.75}
              sx={{
                minHeight: { xs: 32, sm: 36 },
                justifyContent: "flex-end",
                alignItems: "center",
                mb: 0.25,
              }}
            >
              {message.source}
              <Box sx={{ color: "text.secondary" }}>
                <MessageTimestamp
                  value={message.createdAt}
                  align="end"
                  desktopOnly
                />
              </Box>
              {openAuthor ? (
                <ButtonBase
                  aria-label={`Open agent ${senderName} from name`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openAuthor();
                  }}
                  sx={{
                    minHeight: 28,
                    borderRadius: 0.75,
                    textAlign: "right",
                    "& [data-message-sender]": { mb: 0, fontSize: 14 },
                  }}
                >
                  <MessageSenderLabel name={senderName} />
                </ButtonBase>
              ) : (
                <Box
                  sx={{
                    "& [data-message-sender]": { mb: 0, fontSize: 14 },
                  }}
                >
                  <MessageSenderLabel name={senderName} />
                </Box>
              )}
              {openAuthor ? (
                <Tooltip title={`Open ${senderName}`}>
                  <ButtonBase
                    aria-label={`Open agent ${senderName} from profile image`}
                    onClick={(event) => {
                      event.stopPropagation();
                      openAuthor();
                    }}
                    sx={{ borderRadius: "50%", flex: "0 0 auto" }}
                  >
                    {avatar}
                  </ButtonBase>
                </Tooltip>
              ) : (
                avatar
              )}
            </Stack>
          ) : null}
          <Box
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
            {author.kind === "operator" || author.kind === "notice" ? <Box sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}><MessageSenderLabel name={senderName} /></Box> : null}
            {message.body}
            {message.afterBody}
            <ChatAttachments
              attachments={message.attachments ?? []}
            />
          </Box>
          {message.belowBody}
          <MessageActionsAndTimestamp
            actionAlign={fromOperator ? "end" : "start"}
            mobileTimestampAlign={fromOperator ? "end" : "start"}
            mobileTimestampRevealed={mobileTimestampRevealed}
            showTimestamp={false}
            value={message.createdAt}
            status={message.status}
            footer={message.footer}
            actions={message.actions}
          />
        </Box>
      </Stack>
    </Box>
  );
}
