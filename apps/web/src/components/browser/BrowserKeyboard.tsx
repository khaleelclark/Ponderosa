import KeyboardIcon from "@mui/icons-material/Keyboard";
import { Box, IconButton, Tooltip } from "@mui/material";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** A real editable element is required to summon mobile system keyboards. */
export function BrowserKeyboard({ disabled, onText, onKey, portalTarget }: { disabled?: boolean; onText(text: string): void; onKey(key: string): void; portalTarget?: Element | null }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const clear = () => { if (input.current) input.current.value = "\u200b"; };
  useEffect(() => {
    const element = input.current;
    const before = (event: InputEvent) => {
      if (disabled || event.isComposing) return;
      if (event.inputType.startsWith("delete")) { event.preventDefault(); onKey(event.inputType === "deleteContentForward" ? "Delete" : "Backspace"); clear(); }
    };
    element?.addEventListener("beforeinput", before);
    return () => element?.removeEventListener("beforeinput", before);
  }, [disabled, onKey]);
  const flush = (element: HTMLTextAreaElement) => {
    const value = element.value.replace(/^\u200b/, "");
    if (!disabled && value) onText(value);
    clear();
  };
  const control = <>
    <Tooltip title="Keyboard"><span><IconButton size="small" aria-label="Keyboard" disabled={disabled} onClick={() => { clear(); input.current?.focus({ preventScroll: true }); input.current?.setSelectionRange(1, 1); }}><KeyboardIcon fontSize="small" /></IconButton></span></Tooltip>
    <Box component="textarea" ref={input} aria-label="Browser mobile keyboard" defaultValue={"\u200b"} disabled={disabled}
      autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={event => { composing.current = false; flush(event.currentTarget); }}
      onChange={event => { if (!composing.current) flush(event.currentTarget); }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.key.length === 1) return;
        if (["Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); onKey(event.key); clear();
          if (event.key === "Escape") event.currentTarget.blur();
        }
      }}
      onBlur={clear}
      sx={{ position: "absolute", width: 1, height: 1, opacity: .01, pointerEvents: "none", fontSize: 16, p: 0, border: 0 }} />
  </>;
  return portalTarget === null ? null : portalTarget ? createPortal(control, portalTarget) : control;
}
