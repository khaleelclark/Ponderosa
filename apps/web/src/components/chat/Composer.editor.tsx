import { Box, Chip } from "@mui/material";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ClipboardEventHandler,
  type CompositionEventHandler,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type MutableRefObject,
  type ReactEventHandler,
  type UIEventHandler,
} from "react";

export type ComposerEditorElement = HTMLDivElement & {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
};

export type ComposerEditorToken = {
  start: number;
  end: number;
  handle: string;
  title: string;
  valid: boolean;
  kind: "agent" | "special";
};

const BLOCK_ELEMENTS = new Set(["DIV", "LI", "P"]);

function serializedChildren(parent: ParentNode): string {
  let result = "";
  for (const child of parent.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.nodeValue ?? "";
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    const tokenText = child.dataset.composerTokenText;
    if (tokenText !== undefined) {
      result += tokenText;
      continue;
    }
    if (child.tagName === "BR") {
      result += "\n";
      continue;
    }
    const block = BLOCK_ELEMENTS.has(child.tagName);
    if (block && result && !result.endsWith("\n")) result += "\n";
    const nested = serializedChildren(child);
    result += block && nested === "\n" ? "" : nested;
  }
  return result;
}

function serializedRangePrefix(
  root: HTMLElement,
  node: Node,
  offset: number,
): number {
  try {
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(node, offset);
    return serializedChildren(range.cloneContents()).length;
  } catch {
    return serializedChildren(root).length;
  }
}

function editorSelection(root: HTMLElement): { start: number; end: number } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const end = serializedChildren(root).length;
    return { start: end, end };
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    const end = serializedChildren(root).length;
    return { start: end, end };
  }
  return {
    start: serializedRangePrefix(root, range.startContainer, range.startOffset),
    end: serializedRangePrefix(root, range.endContainer, range.endOffset),
  };
}

function textPoint(
  root: HTMLElement,
  requestedOffset: number,
): { node: Node; offset: number } {
  const offset = Math.max(0, Math.min(requestedOffset, serializedChildren(root).length));
  const children = [...root.childNodes];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!(child instanceof HTMLElement)) continue;
    const start = Number(child.dataset.composerStart);
    const end = Number(child.dataset.composerEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (offset < start) return { node: root, offset: index };
    if (child.dataset.composerTokenText !== undefined) {
      if (offset < end) {
        return {
          node: root,
          offset: index + (offset - start >= (end - start) / 2 ? 1 : 0),
        };
      }
      if (offset === end) return { node: root, offset: index + 1 };
      continue;
    }
    if (offset <= end) {
      const textNode = [...child.childNodes].find(
        node => node.nodeType === Node.TEXT_NODE,
      );
      if (textNode) {
        return {
          node: textNode,
          offset: Math.max(
            0,
            Math.min(offset - start, textNode.nodeValue?.length ?? 0),
          ),
        };
      }
      return { node: child, offset: 0 };
    }
  }
  return { node: root, offset: root.childNodes.length };
}

function setEditorSelection(root: HTMLElement, start: number, end: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const startPoint = textPoint(root, start);
  const endPoint = textPoint(root, end);
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function enhanceEditor(element: HTMLDivElement): ComposerEditorElement {
  const editor = element as ComposerEditorElement;
  if (Object.prototype.hasOwnProperty.call(editor, "selectionStart")) return editor;
  Object.defineProperties(editor, {
    value: {
      configurable: true,
      get: () => serializedChildren(editor),
    },
    selectionStart: {
      configurable: true,
      get: () => editorSelection(editor).start,
    },
    selectionEnd: {
      configurable: true,
      get: () => editorSelection(editor).end,
    },
  });
  editor.setSelectionRange = (start, end) => setEditorSelection(editor, start, end);
  return editor;
}

export function ComposerTokenEditor({
  value,
  caret,
  inputRef,
  disabled,
  locked,
  placeholder,
  inputProps,
  mentionTokens,
  textIndent,
  onTextChange,
  onPaste,
  onClick,
  onSelect,
  onKeyUp,
  onKeyDown,
  onScroll,
  onFocus,
  onBlur,
  onRemoveMention,
}: {
  value: string;
  caret: number;
  inputRef: MutableRefObject<ComposerEditorElement | null>;
  disabled: boolean;
  locked?: boolean;
  placeholder: string;
  inputProps?: {
    "aria-label"?: string;
    "aria-autocomplete"?: "none" | "inline" | "list" | "both";
    "aria-expanded"?: boolean;
    "aria-controls"?: string;
    "aria-activedescendant"?: string;
    enterKeyHint?: string;
    role?: string;
  };
  mentionTokens: ComposerEditorToken[];
  textIndent: number;
  onTextChange(value: string, caret: number): void;
  onPaste: ClipboardEventHandler<ComposerEditorElement>;
  onClick?: MouseEventHandler<ComposerEditorElement>;
  onSelect?: ReactEventHandler<ComposerEditorElement>;
  onKeyUp?: KeyboardEventHandler<ComposerEditorElement>;
  onKeyDown: KeyboardEventHandler<ComposerEditorElement>;
  onScroll?: UIEventHandler<ComposerEditorElement>;
  onFocus?: FocusEventHandler<ComposerEditorElement>;
  onBlur?: FocusEventHandler<ComposerEditorElement>;
  onRemoveMention(start: number, end: number): void;
}): JSX.Element {
  const composing = useRef(false);
  const setEditorRef = useCallback((element: HTMLDivElement | null) => {
    inputRef.current = element ? enhanceEditor(element) : null;
  }, [inputRef]);

  const syncInput = useCallback((editor: ComposerEditorElement) => {
    const selection = editorSelection(editor);
    onTextChange(serializedChildren(editor), selection.start);
  }, [onTextChange]);

  useLayoutEffect(() => {
    const editor = inputRef.current;
    if (!editor || document.activeElement !== editor || composing.current) return;
    editor.setSelectionRange(caret, caret);
  }, [inputRef, value]);

  const compositionStart: CompositionEventHandler<ComposerEditorElement> = () => {
    composing.current = true;
  };
  const compositionEnd: CompositionEventHandler<ComposerEditorElement> = event => {
    composing.current = false;
    syncInput(event.currentTarget);
  };

  const rendered = [];
  let cursor = 0;
  for (const token of mentionTokens) {
    if (cursor < token.start) {
      rendered.push(
        <Box
          component="span"
          data-composer-start={cursor}
          data-composer-end={token.start}
          key={`text:${cursor}`}
        >
          {value.slice(cursor, token.start)}
        </Box>,
      );
    }
    rendered.push(
      <Chip
        component="span"
        contentEditable={false}
        data-composer-token-text={value.slice(token.start, token.end)}
        data-composer-start={token.start}
        data-composer-end={token.end}
        key={`${token.start}:${token.handle}`}
        size="small"
        label={`#${token.handle}`}
        title={token.kind === "special"
          ? token.title
          : token.valid
            ? `Agent: ${token.title}`
            : `Unavailable Agent: ${token.title}`}
        aria-label={token.kind === "special"
          ? `${token.title} tag`
          : token.valid
            ? `Agent mention ${token.title}`
            : `Unavailable Agent mention ${token.title}`}
        onDelete={() => onRemoveMention(token.start, token.end)}
        sx={{
          display: "inline-flex",
          verticalAlign: "baseline",
          height: 26,
          bgcolor: token.valid ? "action.selected" : "error.dark",
          color: token.valid ? "primary.main" : "error.contrastText",
          fontSize: 16,
          fontWeight: 700,
          lineHeight: "22px",
          boxShadow: token.valid
            ? "inset 0 0 0 1px rgba(127, 196, 142, .18)"
            : undefined,
          textIndent: 0,
          "& .MuiChip-label": { px: 0.75 },
          "& .MuiChip-deleteIcon": {
            color: "inherit",
            fontSize: 18,
            ml: -0.25,
            mr: 0.5,
            opacity: 1,
          },
        }}
      />,
    );
    cursor = token.end;
  }
  if (cursor < value.length) {
    rendered.push(
      <Box
        component="span"
        data-composer-start={cursor}
        data-composer-end={value.length}
        key={`text:${cursor}:end`}
      >
        {value.slice(cursor)}
      </Box>,
    );
  }

  return (
    <Box
      ref={setEditorRef}
      contentEditable={disabled || locked ? false : "plaintext-only"}
      suppressContentEditableWarning
      role={inputProps?.role ?? "textbox"}
      aria-label={inputProps?.["aria-label"] ?? "Message"}
      aria-multiline="true"
      aria-autocomplete={inputProps?.["aria-autocomplete"]}
      aria-expanded={inputProps?.["aria-expanded"]}
      aria-controls={inputProps?.["aria-controls"]}
      aria-activedescendant={inputProps?.["aria-activedescendant"]}
      enterKeyHint={inputProps?.enterKeyHint as "enter" | "done" | "go" | "next" | "previous" | "search" | "send" | undefined}
      data-placeholder={placeholder}
      onInput={event => {
        if (!composing.current) {
          syncInput(event.currentTarget as ComposerEditorElement);
        }
      }}
      onCompositionStart={compositionStart}
      onCompositionEnd={compositionEnd}
      onPaste={onPaste}
      onClick={onClick}
      onSelect={onSelect}
      onKeyUp={onKeyUp}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
      onFocus={onFocus}
      onBlur={onBlur}
      sx={{
        minHeight: 22,
        maxHeight: 110,
        overflowY: "auto",
        outline: "none",
        px: 0.25,
        pt: 0.75,
        pb: 0.5,
        fontSize: 15,
        lineHeight: "22px",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        textIndent: textIndent ? `${textIndent + 8}px` : 0,
        color: disabled || locked ? "text.disabled" : "text.primary",
        caretColor: "text.primary",
        cursor: disabled || locked ? "default" : "text",
        "&:empty::before": {
          content: "attr(data-placeholder)",
          color: "text.secondary",
          pointerEvents: "none",
        },
      }}
    >
      {rendered}
    </Box>
  );
}
