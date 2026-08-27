import AddIcon from "@mui/icons-material/Add";
import ArticleIcon from "@mui/icons-material/Article";
import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  Box,
  Button,
  Chip,
  ClickAwayListener,
  Divider,
  IconButton,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type {
  AssetLimitsDto,
  EngineCommand,
  EngineComposerCapability,
  FileEntryDto,
} from "@ponderosa/core";
import {
  LONG_TEXT_MAX_UTF8_BYTES,
  utf8ByteLength,
} from "@ponderosa/core";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { compactPreviewText } from "./Composer.helpers";
import { ComposerMentionStatus } from "./Composer.parts";
import {
  COMPOSER_MAX_FILE_BYTES,
  COMPOSER_MAX_FILES,
  composerCapabilityDisabledReason,
  composerSubmissionText,
  engineCommandDisabledReason,
  filesFromClipboard,
  shouldExtractLongPaste,
  shouldIgnoreComposerKey,
  shouldSendComposerKey,
} from "./composerUtils";

export function ComposerNotices({
  pastedText,
  pastedTextBytes,
  error,
  displacedDraft,
  onShowPastedText,
  onRemovePastedText,
  onRestoreDraft,
  onClearError,
}: {
  pastedText?: string;
  pastedTextBytes: number;
  error?: string;
  displacedDraft?: string;
  onShowPastedText(): void;
  onRemovePastedText(): void;
  onRestoreDraft(): void;
  onClearError(): void;
}): JSX.Element {
  return (
    <>
      {pastedText ? (
        <Paper
          variant="outlined"
          sx={{
            mb: 1,
            px: 1,
            py: 0.75,
            display: "flex",
            alignItems: "center",
            gap: 1,
            maxWidth: 360,
          }}
        >
          <ArticleIcon color="action" fontSize="small" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" noWrap>
              Pasted text
            </Typography>
            <Button
              size="small"
              sx={{ p: 0, minWidth: 0, textTransform: "none" }}
              onClick={onShowPastedText}
            >
              Show in Text Field
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {pastedTextBytes.toLocaleString()} bytes
          </Typography>
          <IconButton
            size="small"
            aria-label="Remove pasted text"
            onClick={onRemovePastedText}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Paper>
      ) : null}
      {error ? (
        <Alert severity="error" sx={{ mb: 1 }} onClose={onClearError}>
          Message not sent. {error}
        </Alert>
      ) : null}
      {displacedDraft ? (
        <Alert
          severity="warning"
          sx={{ mb: 1 }}
          action={
            <Button size="small" onClick={onRestoreDraft}>
              Restore
            </Button>
          }
        >
          This draft changed elsewhere. Your displaced text is preserved: “
          {compactPreviewText(displacedDraft)}”
        </Alert>
      ) : null}
    </>
  );
}

export function ComposerTextInput({
  text,
  inputRef,
  disabled,
  locked,
  placeholder,
  comboboxEnabled,
  menuOpen,
  listId,
  highlighted,
  attachmentsEnabled,
  pastedText,
  menuSuggestions,
  destinationMode,
  requiredRecipient,
  inlineDestination,
  mentionTokens,
  mentionedBusyHandles,
  mentionedHandles,
  canSend,
  onTextChange,
  onFiles,
  onPastedText,
  onPasteError,
  onCaretChange,
  onHighlightChange,
  onSuppressMenu,
  onApplySuggestion,
  onClearRequiredRecipient,
  onRemoveMention,
  onSend,
}: {
  text: string;
  inputRef: RefObject<HTMLTextAreaElement>;
  disabled: boolean;
  locked: boolean;
  placeholder?: string;
  comboboxEnabled: boolean;
  menuOpen: boolean;
  listId: string;
  highlighted: number;
  attachmentsEnabled: boolean;
  pastedText?: string;
  menuSuggestions: ComposerMenuSuggestion[];
  destinationMode?: "project-chat" | "fixed" | "target-required";
  requiredRecipient?: { handle: string; title: string; onClear(): void };
  inlineDestination?: { handle: string; onClear(): void };
  mentionTokens: Array<{
    start: number;
    end: number;
    handle: string;
    title: string;
    valid: boolean;
    kind: "agent" | "special";
  }>;
  mentionedBusyHandles: string[];
  mentionedHandles: string[];
  canSend: boolean;
  onTextChange(value: string, caret: number): void;
  onFiles(files: File[]): void;
  onPastedText(value: string): void;
  onPasteError(message: string): void;
  onCaretChange(caret: number): void;
  onHighlightChange(index: number): void;
  onSuppressMenu(): void;
  onApplySuggestion(suggestion: ComposerMenuSuggestion): void;
  onClearRequiredRecipient(): void;
  onRemoveMention(start: number, end: number): void;
  onSend(): void;
}): JSX.Element {
  const destinationRef = useRef<HTMLDivElement>(null);
  const [destinationWidth, setDestinationWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    const element = destinationRef.current;
    if (!element || !inlineDestination) {
      setDestinationWidth(0);
      return;
    }
    const update = () => setDestinationWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [inlineDestination?.handle]);

  return (
    <>
      <Box sx={{ position: "relative", minWidth: 0 }}>
        {inlineDestination ? (
          <Chip
            ref={destinationRef}
            size="small"
            label={`#${inlineDestination.handle}`}
            title={`Send to #${inlineDestination.handle}`}
            aria-label={`Recipient: ${inlineDestination.handle}`}
            onDelete={inlineDestination.onClear}
            sx={{
              position: "absolute",
              zIndex: 3,
              top: 0,
              left: 2,
              maxWidth: "min(42%, 240px)",
              height: 24,
              bgcolor: "action.selected",
              color: "primary.main",
              fontWeight: 700,
              boxShadow: "inset 0 0 0 1px rgba(127, 196, 142, .18)",
              "& .MuiChip-label": {
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
              },
              "& .MuiChip-deleteIcon": { color: "primary.main" },
            }}
          />
        ) : null}
        {text && mentionTokens.length > 0 ? (
          <Box
            sx={{
              position: "absolute",
              zIndex: 3,
              inset: "0 2px auto 2px",
              maxHeight: 110,
              overflow: "hidden",
              pointerEvents: "none",
              fontSize: 15,
              lineHeight: "22px",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              color: "text.primary",
              textIndent: destinationWidth ? `${destinationWidth + 8}px` : 0,
              transform: `translateY(-${scrollTop}px)`,
            }}
          >
            {(() => {
              const rendered: ReactNode[] = [];
              let cursor = 0;
              for (const token of mentionTokens) {
                rendered.push(
                  <Box component="span" aria-hidden="true" key={`text:${cursor}`}>
                    {text.slice(cursor, token.start)}
                  </Box>,
                );
                rendered.push(
                  <Box
                    component="span"
                    key={`${token.start}:${token.handle}`}
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
                    sx={{
                      display: "inline",
                      position: "relative",
                      borderRadius: 0.75,
                      bgcolor: theme => token.valid
                        ? alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.2 : 0.12)
                        : theme.palette.error.dark,
                      color: token.valid ? "success.main" : "error.contrastText",
                      boxShadow: token.valid ? "inset 0 0 0 1px currentColor" : undefined,
                      boxDecorationBreak: "clone",
                      WebkitBoxDecorationBreak: "clone",
                      fontWeight: "inherit",
                      textIndent: 0,
                      pointerEvents: "none",
                    }}
                  >
                    #{token.handle}
                    <Box
                      component="button"
                      type="button"
                      aria-label={token.kind === "special"
                        ? `Remove ${token.title} tag`
                        : `Remove Agent mention ${token.title}`}
                      onClick={() => onRemoveMention(token.start, token.end)}
                      sx={{
                        appearance: "none",
                        position: "absolute",
                        zIndex: 3,
                        top: "0.2em",
                        right: 0,
                        width: 10,
                        height: 10,
                        border: 0,
                        bgcolor: "transparent",
                        color: "inherit",
                        font: "inherit",
                        fontSize: 9,
                        lineHeight: 1,
                        cursor: "pointer",
                        p: 0,
                        pointerEvents: "auto",
                        opacity: 0.9,
                      }}
                    >
                      ×
                    </Box>
                  </Box>,
                );
                cursor = token.end;
              }
              rendered.push(
                <Box component="span" aria-hidden="true" key={`text:${cursor}:end`}>
                  {text.slice(cursor)}
                </Box>,
              );
              return rendered;
            })()}
          </Box>
        ) : null}
        <TextField
        fullWidth
        multiline
        variant="standard"
        minRows={1}
        maxRows={5}
        sx={{
          "& .MuiInputBase-root": {
            position: "relative",
            zIndex: 2,
            alignItems: "flex-end",
            bgcolor: "transparent",
            px: 0.25,
            pb: 0.5,
          },
          "& textarea": {
            fontSize: 15,
            lineHeight: "22px",
            maxHeight: "110px !important",
            overflowY: "auto !important",
            textIndent: destinationWidth ? `${destinationWidth + 8}px` : 0,
            ...(mentionTokens.length > 0 ? {
              color: "transparent",
              caretColor: theme => theme.palette.text.primary,
              "&::selection": {
                color: theme => theme.palette.text.primary,
                bgcolor: theme => alpha(theme.palette.primary.main, 0.32),
              },
            } : {}),
          },
        }}
        InputProps={{
          disableUnderline: true,
        }}
        value={text}
        inputRef={inputRef}
        disabled={disabled || locked}
        placeholder={locked ? "Agent is working" : (placeholder ?? "Send a message")}
        inputProps={{
          "aria-label": "Message",
          enterKeyHint: "send",
          role: comboboxEnabled ? "combobox" : undefined,
          "aria-autocomplete": comboboxEnabled ? "list" : undefined,
          "aria-expanded": comboboxEnabled ? menuOpen : undefined,
          "aria-controls": menuOpen ? listId : undefined,
          "aria-activedescendant": menuOpen
            ? `${listId}-option-${highlighted}`
            : undefined,
        }}
        onChange={event =>
          onTextChange(
            event.target.value,
            event.target.selectionStart ?? event.target.value.length,
          )
        }
        onPaste={event => {
          if (disabled || locked) return;
          if (attachmentsEnabled) {
            const files = filesFromClipboard(
              event.clipboardData.items,
              event.clipboardData.files,
            );
            if (files.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              onFiles(files);
              return;
            }
          }
          const pasted = event.clipboardData.getData("text/plain");
          if (!shouldExtractLongPaste(pasted)) return;
          event.preventDefault();
          const combined = composerSubmissionText(pastedText ?? "", pasted);
          if (utf8ByteLength(combined) > LONG_TEXT_MAX_UTF8_BYTES) {
            onPasteError("Pasted text exceeds the 8 MiB limit.");
            return;
          }
          onPastedText(combined);
        }}
        onClick={event =>
          onCaretChange(
            (event.target as HTMLTextAreaElement).selectionStart ?? 0,
          )
        }
        onScroll={event => setScrollTop((event.target as HTMLTextAreaElement).scrollTop)}
        onKeyUp={event =>
          onCaretChange(
            (event.target as HTMLTextAreaElement).selectionStart ?? 0,
          )
        }
        onKeyDown={event => {
          const textarea = inputRef.current;
          const selectionStart = textarea?.selectionStart ?? 0;
          const selectionEnd = textarea?.selectionEnd ?? selectionStart;
          if (selectionStart === selectionEnd) {
            const token = mentionTokens.find(candidate =>
              event.key === "Backspace"
                ? selectionStart > candidate.start && selectionStart <= candidate.end
                : event.key === "Delete"
                  ? selectionStart >= candidate.start && selectionStart < candidate.end
                  : event.key === "ArrowLeft"
                    ? selectionStart > candidate.start && selectionStart <= candidate.end
                    : event.key === "ArrowRight"
                      ? selectionStart >= candidate.start && selectionStart < candidate.end
                      : false);
            if (token) {
              event.preventDefault();
              if (event.key === "Backspace" || event.key === "Delete") {
                onRemoveMention(token.start, token.end);
              } else {
                const nextCaret = event.key === "ArrowLeft" ? token.start : token.end;
                textarea?.setSelectionRange(nextCaret, nextCaret);
                onCaretChange(nextCaret);
              }
              return;
            }
          }
          if (
            event.key === "Backspace" &&
            inlineDestination &&
            text.length === 0 &&
            textarea?.selectionStart === 0 &&
            textarea.selectionEnd === 0
          ) {
            event.preventDefault();
            inlineDestination.onClear();
            return;
          }
          if (
            shouldIgnoreComposerKey({
              key: event.key,
              isComposing: event.nativeEvent.isComposing,
            })
          ) return;
          if (menuOpen && event.key === "ArrowDown") {
            event.preventDefault();
            onHighlightChange((highlighted + 1) % menuSuggestions.length);
            return;
          }
          if (menuOpen && event.key === "ArrowUp") {
            event.preventDefault();
            onHighlightChange(
              (highlighted - 1 + menuSuggestions.length) %
                menuSuggestions.length,
            );
            return;
          }
          if (
            menuOpen &&
            (event.key === "Enter" || event.key === "Tab") &&
            !event.metaKey &&
            !event.ctrlKey
          ) {
            event.preventDefault();
            onApplySuggestion(menuSuggestions[highlighted]!);
            return;
          }
          if (menuOpen && event.key === "Escape") {
            event.preventDefault();
            onSuppressMenu();
            return;
          }
          if (
            event.key === "Escape" &&
            destinationMode === "target-required" &&
            requiredRecipient
          ) {
            event.preventDefault();
            onClearRequiredRecipient();
            return;
          }
          if (
            shouldSendComposerKey({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              repeat: event.repeat,
            }) &&
            canSend
          ) {
            event.preventDefault();
            onSend();
          }
        }}
        />
      </Box>
      <ComposerMentionStatus
        destinationMode={destinationMode}
        mentionedBusyHandles={mentionedBusyHandles}
        mentionedHandles={mentionedHandles}
      />
    </>
  );
}

export function ComposerCapabilityPicker({
  fileInput,
  disabled,
  menuAnchor,
  listId,
  filter,
  attachmentsEnabled,
  attachmentsUnavailableReason,
  fileCount,
  assetLimits,
  capabilities,
  visibleCapabilities,
  onFiles,
  onOpen,
  onClose,
  onFilterChange,
  onApplyCapability,
}: {
  fileInput: RefObject<HTMLInputElement>;
  disabled: boolean;
  menuAnchor: HTMLElement | null;
  listId: string;
  filter: string;
  attachmentsEnabled: boolean;
  attachmentsUnavailableReason?: string;
  fileCount: number;
  assetLimits?: AssetLimitsDto;
  capabilities?: EngineComposerCapability[];
  visibleCapabilities: EngineComposerCapability[];
  onFiles(files: File[]): void;
  onOpen(anchor: HTMLElement): void;
  onClose(): void;
  onFilterChange(value: string): void;
  onApplyCapability(capability: EngineComposerCapability): void;
}): JSX.Element {
  const maximumFiles = assetLimits?.maxAssetsPerMessage ?? COMPOSER_MAX_FILES;
  return (
    <>
      <input
        ref={fileInput}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,application/json,application/zip,.txt,.md,.csv,.log,.json,.zip,.pdf"
        multiple
        onChange={event => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Tooltip title="Add an image, file, skill, plugin, or connector">
        <span>
          <IconButton
            aria-label="Add attachment or capability"
            aria-haspopup="menu"
            aria-expanded={Boolean(menuAnchor)}
            aria-controls={menuAnchor ? listId : undefined}
            disabled={disabled}
            onClick={event => onOpen(event.currentTarget)}
          >
            <AddIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Popper
        open={Boolean(menuAnchor)}
        anchorEl={menuAnchor}
        placement="top-start"
        style={{ zIndex: 1400 }}
      >
        <ClickAwayListener onClickAway={onClose}>
          <Paper
            elevation={5}
            sx={{
              mb: 0.5,
              width: "min(420px, calc(100vw - 24px))",
              maxHeight: "min(52vh, 390px)",
              overflow: "hidden",
            }}
          >
            <Box sx={{ p: 1, borderBottom: 1, borderColor: "divider" }}>
              <TextField
                autoFocus
                fullWidth
                size="small"
                value={filter}
                onChange={event => onFilterChange(event.target.value)}
                placeholder="Find a skill, plugin, or connector"
                inputProps={{ "aria-label": "Filter runtime capabilities" }}
              />
            </Box>
            <MenuList
              dense
              id={listId}
              aria-label="Add attachment or runtime capability"
              sx={{
                maxHeight: "min(38vh, 300px)",
                overflowY: "auto",
                overscrollBehavior: "contain",
              }}
            >
              <MenuItem
                disabled={!attachmentsEnabled || fileCount >= maximumFiles}
                onClick={() => {
                  onClose();
                  fileInput.current?.click();
                }}
                sx={{
                  whiteSpace: "normal",
                  alignItems: "flex-start",
                  minHeight: 54,
                }}
              >
                <Box>
                  <Typography variant="body2">Upload image or file</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {!attachmentsEnabled
                      ? (attachmentsUnavailableReason ??
                        "Attachments are not supported in this chat.")
                      : fileCount >= maximumFiles
                        ? "Remove an attachment before adding another."
                        : `Up to ${maximumFiles} PNG, JPEG, WebP, PDF, text, JSON, or ZIP files · ${Math.floor((assetLimits?.maxFileBytes ?? COMPOSER_MAX_FILE_BYTES) / 1024 / 1024)} MiB each`}
                  </Typography>
                </Box>
              </MenuItem>
              <Divider />
              {(capabilities ?? []).length === 0 ? (
                <MenuItem disabled sx={{ whiteSpace: "normal" }}>
                  <Typography variant="caption">
                    No runtime skills, plugins, or connectors are currently
                    available.
                  </Typography>
                </MenuItem>
              ) : visibleCapabilities.length === 0 ? (
                <MenuItem disabled>
                  <Typography variant="caption">
                    No capabilities match “{filter.trim()}”.
                  </Typography>
                </MenuItem>
              ) : (
                visibleCapabilities.map(capability => {
                  const reason = composerCapabilityDisabledReason(capability);
                  const automatic =
                    capability.status === "available" && !capability.insertText;
                  return (
                    <MenuItem
                      key={capability.id}
                      disabled={Boolean(reason)}
                      onClick={() => onApplyCapability(capability)}
                      sx={{
                        whiteSpace: "normal",
                        alignItems: "flex-start",
                        minHeight: 58,
                        py: 0.75,
                        ...(automatic
                          ? {
                              "&.Mui-disabled": {
                                opacity: 1,
                                cursor: "default",
                              },
                            }
                          : {}),
                      }}
                    >
                      <Box sx={{ minWidth: 0, width: "100%" }}>
                        <Stack
                          direction="row"
                          spacing={0.75}
                          sx={{ alignItems: "center", minWidth: 0 }}
                        >
                          <Typography
                            variant="body2"
                            noWrap
                            sx={{
                              flex: 1,
                              fontWeight: 650,
                              color: automatic ? "text.primary" : undefined,
                            }}
                          >
                            {capability.label}
                          </Typography>
                          <Chip
                            size="small"
                            variant="outlined"
                            color={automatic ? "success" : "default"}
                            label={capability.kind}
                          />
                        </Stack>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            overflowWrap: "anywhere",
                            lineHeight: 1.35,
                          }}
                        >
                          {capability.description}
                        </Typography>
                        {reason ? (
                          <Typography
                            variant="caption"
                            color={
                              automatic ? "text.secondary" : "text.disabled"
                            }
                            noWrap
                            sx={{ display: "block" }}
                          >
                            {reason}
                          </Typography>
                        ) : null}
                      </Box>
                    </MenuItem>
                  );
                })
              )}
            </MenuList>
          </Paper>
        </ClickAwayListener>
      </Popper>
    </>
  );
}

export type ComposerMenuSuggestion =
  | { kind: "command"; command: EngineCommand }
  | { kind: "mention"; handle: string }
  | { kind: "file"; entry: FileEntryDto };

export function ComposerAutocompleteMenu({
  open,
  anchor,
  listId,
  suggestions,
  highlighted,
  onDismiss,
  onSelect,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  listId: string;
  suggestions: ComposerMenuSuggestion[];
  highlighted: number;
  onDismiss(): void;
  onSelect(suggestion: ComposerMenuSuggestion): void;
}): JSX.Element {
  const hasCommands = suggestions.some(item => item.kind === "command");
  const hasMentions = suggestions.some(item => item.kind === "mention");
  return (
    <Popper
      open={open}
      anchorEl={anchor}
      placement="top-start"
      style={{ zIndex: 1400 }}
    >
      <ClickAwayListener onClickAway={onDismiss}>
        <Paper
          elevation={4}
          sx={{
            mb: 0.5,
            minWidth: 180,
            maxWidth: "min(720px, calc(100vw - 24px))",
          }}
        >
          <MenuList
            dense
            id={listId}
            role="listbox"
            aria-label={
              hasCommands
                ? "Commands"
                : hasMentions
                  ? "Agent tags"
                  : "Project files and folders"
            }
            sx={{
              maxHeight: "min(40vh, 360px)",
              overflowY: "auto",
              overscrollBehavior: "contain",
            }}
          >
            {suggestions.map((suggestion, index) => {
              const commandReason =
                suggestion.kind === "command"
                  ? engineCommandDisabledReason(suggestion.command)
                  : undefined;
              return (
                <MenuItem
                  key={
                    suggestion.kind === "mention"
                      ? suggestion.handle
                      : suggestion.kind === "file"
                        ? suggestion.entry.path
                        : suggestion.command.name
                  }
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={index === highlighted}
                  selected={index === highlighted}
                  disabled={Boolean(commandReason)}
                  sx={{ whiteSpace: "normal", alignItems: "flex-start" }}
                  onMouseDown={event => {
                    event.preventDefault();
                    onSelect(suggestion);
                  }}
                >
                  {suggestion.kind === "mention" ? (
                    `#${suggestion.handle}`
                  ) : suggestion.kind === "file" ? (
                    <Box>
                      <Typography variant="body2">
                        @{suggestion.entry.path}
                        {suggestion.entry.kind === "dir" ? "/" : ""}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {suggestion.entry.kind === "dir" ? "Folder" : "File"}
                      </Typography>
                    </Box>
                  ) : (
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2">
                        {suggestion.command.insertText.trimEnd()}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: "block", overflowWrap: "anywhere" }}
                      >
                        {suggestion.command.source} ·{" "}
                        {commandReason ?? suggestion.command.description}
                      </Typography>
                    </Box>
                  )}
                </MenuItem>
              );
            })}
          </MenuList>
        </Paper>
      </ClickAwayListener>
    </Popper>
  );
}
