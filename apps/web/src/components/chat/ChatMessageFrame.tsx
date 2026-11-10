import "./conversation.css";
import { Avatar, ButtonBase, Tooltip } from "@mui/material";
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
  assistantMessages = false,
}: {
  message: ChatMessagePresentation;
  assistantMessages?: boolean;
}): JSX.Element {
  const [mobileTimestampRevealed, setMobileTimestampRevealed] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const author = message.author;
  const fromOperator = author.kind !== "agent" && (!assistantMessages || author.kind !== "inbound_agent");
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
      aria-label={`${senderName} Avatar`}
      sx={{
        width: { xs: 32, sm: 36 },
        height: { xs: 32, sm: 36 },
        bgcolor: (theme) => theme.palette.mode === "dark" ? "#25302F" : "#F0F1EC",
        color: "text.primary",
        fontSize: { xs: "0.8125rem", sm: "0.9375rem" },
        fontWeight: 750,
      }}
    >
      {senderName.slice(0, 1).toLocaleUpperCase()}
    </Avatar>
  );

  return (
    <article
      ref={articleRef}
      id={message.id}
      className={`MuiBox-root chat-message chat-message-frame${assistantMessages ? " chat-message-assistant" : ""}${fromOperator ? " chat-message-end" : ""}${message.status ? " chat-message-has-status" : ""}${selectable ? " chat-message-selectable" : ""}`}
      aria-label={message.ariaLabel ?? `${senderName} Message`}
      onClick={selectable
        ? event => {
            if (!messageSelectionTargetIsInteractive(event.target, event.currentTarget) &&
                !messageSelectionIntersectsCurrentTarget(event.currentTarget)) {
              selectMessage();
            }
          }
        : toggleTimestamp}
    >
      {message.beforeHeader ? (
        <div className="MuiBox-root chat-message-before-header">
          {message.beforeHeader}
        </div>
      ) : null}
      <div className="MuiStack-root chat-message-row">
        {!fromOperator ? openAuthor
          ? <Tooltip title={`Open ${senderName}`}><ButtonBase
              aria-label={`Open Agent ${senderName} From Profile Image`}
              onClick={(event) => { event.stopPropagation(); openAuthor(); }}
              sx={{ borderRadius: "50%", flex: "0 0 auto", minWidth:44,minHeight:44,alignItems:"flex-start",pt:.5 }}
            >{avatar}</ButtonBase></Tooltip>
          : avatar
        : null}
        <div className="MuiBox-root chat-message-column">
          {author.kind === "agent" || assistantMessages && author.kind === "inbound_agent" ? (
            <div className="MuiStack-root chat-message-agent-header">
              {openAuthor ? <ButtonBase
                aria-label={`Open Agent ${senderName} From Name`}
                onClick={(event) => { event.stopPropagation(); openAuthor(); }}
                sx={{ minHeight: 32, borderRadius: 0.75, textAlign: "left", "& [data-message-sender]": { mb: 0, fontSize: "0.875rem" } }}
              ><MessageSenderLabel name={senderName} /></ButtonBase>
                : <div className="MuiBox-root chat-message-agent-name"><MessageSenderLabel name={senderName} /></div>}
              {message.source}
              <div className="MuiBox-root chat-message-secondary"><MessageTimestamp value={message.createdAt} align="start" desktopOnly /></div>
            </div>
          ) : author.kind === "operator" ? (
            <div className="MuiStack-root chat-message-operator-header">
              {message.source}
              <ChatOperatorLabel profile={operatorProfile} createdAt={message.createdAt} />
            </div>
          ) : author.kind === "inbound_agent" ? (
            <div className="MuiStack-root chat-message-inbound-header">
              {message.source}
              <div className="MuiBox-root chat-message-secondary">
                <MessageTimestamp
                  value={message.createdAt}
                  align="end"
                  desktopOnly
                />
              </div>
              {openAuthor ? (
                <ButtonBase
                  aria-label={`Open Agent ${senderName} From Name`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openAuthor();
                  }}
                  sx={{
                    minHeight: 28,
                    borderRadius: 0.75,
                    textAlign: "right",
                    "& [data-message-sender]": { mb: 0, fontSize: "0.875rem" },
                  }}
                >
                  <MessageSenderLabel name={senderName} />
                </ButtonBase>
              ) : (
                <div className="MuiBox-root chat-message-agent-name">
                  <MessageSenderLabel name={senderName} />
                </div>
              )}
              {openAuthor ? (
                <Tooltip title={`Open ${senderName}`}>
                  <ButtonBase
                    aria-label={`Open Agent ${senderName} From Profile Image`}
                    onClick={(event) => {
                      event.stopPropagation();
                      openAuthor();
                    }}
                    sx={{ borderRadius: "50%", flex: "0 0 auto", minWidth:44,minHeight:44,alignItems:"flex-start",pt:.5 }}
                  >
                    {avatar}
                  </ButtonBase>
                </Tooltip>
              ) : (
                avatar
              )}
            </div>
          ) : null}
          <div className="MuiBox-root chat-message-body">
            {author.kind === "operator" || author.kind === "notice" ? <div className="MuiBox-root chat-message-accessible-name"><MessageSenderLabel name={senderName} /></div> : null}
            {message.body}
            {message.afterBody}
            <ChatAttachments
              attachments={message.attachments ?? []}
            />
          </div>
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
        </div>
      </div>
    </article>
  );
}
