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
import type {
  AssetLimitsDto,
  EngineCommand,
  EngineComposerCapability,
  FileEntryDto,
} from "@ponderosa/core";
import { type RefObject } from "react";
import { compactPreviewText } from "./Composer.helpers";
import { ComposerMentionStatus } from "./Composer.parts";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerMentionDescriptor,
} from "./ComposerEditor";
import {
  COMPOSER_MAX_FILE_BYTES,
  COMPOSER_MAX_FILES,
  composerCapabilityDisabledReason,
  engineCommandDisabledReason,
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
  mentionTokens,
  mentionedBusyHandles,
  mentionedHandles,
  canSend,
  onTextChange,
  onFiles,
  onPastedText,
  onPasteError,
  onHighlightChange,
  onSuppressMenu,
  onApplySuggestion,
  onClearRequiredRecipient,
  onSend,
}: {
  text: string;
  inputRef: RefObject<ComposerEditorHandle>;
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
  mentionTokens: ComposerMentionDescriptor[];
  mentionedBusyHandles: string[];
  mentionedHandles: string[];
  canSend: boolean;
  onTextChange(value: string, caret: number): void;
  onFiles(files: File[]): void;
  onPastedText(value: string): void;
  onPasteError(message: string): void;
  onHighlightChange(index: number): void;
  onSuppressMenu(): void;
  onApplySuggestion(suggestion: ComposerMenuSuggestion): void;
  onClearRequiredRecipient(): void;
  onSend(): void;
}): JSX.Element {
  return (
    <>
      <ComposerEditor
        ref={inputRef}
        text={text}
        disabled={disabled}
        locked={locked}
        placeholder={placeholder}
        comboboxEnabled={comboboxEnabled}
        menuOpen={menuOpen}
        listId={listId}
        highlighted={highlighted}
        attachmentsEnabled={attachmentsEnabled}
        pastedText={pastedText}
        menuSuggestions={menuSuggestions}
        destinationMode={destinationMode}
        requiredRecipient={requiredRecipient}
        mentionDescriptors={mentionTokens}
        canSend={canSend}
        onTextChange={onTextChange}
        onFiles={onFiles}
        onPastedText={onPastedText}
        onPasteError={onPasteError}
        onHighlightChange={onHighlightChange}
        onSuppressMenu={onSuppressMenu}
        onApplySuggestion={onApplySuggestion}
        onClearRequiredRecipient={onClearRequiredRecipient}
        onSend={onSend}
      />
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
