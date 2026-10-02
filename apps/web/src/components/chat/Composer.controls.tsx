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
  ListSubheader,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type {
  AgentMentionBindingDto,
  AssetLimitsDto,
  ConversationDraftConflictDto,
  EngineCommand,
  EngineComposerCapability,
  ArtifactDto,
} from "@ponderosa/core";
import { type RefObject, useEffect, useRef, useState } from "react";
import { isIOSDevice } from "../../browserPlatform";
import type { ComposerMenuAction } from "./composerContracts";
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
  capabilityDisplayName,
} from "./composerUtils";

export function ComposerNotices({
  pastedText,
  pastedTextBytes,
  error,
  attachmentError = false,
  draftConflict,
  failedDraftContents,
  onShowPastedText,
  onRemovePastedText,
  onRestoreDraft,
  onDiscardDraft,
  restoringDraft,
  mutationLocked,
  onRetryDraftContent,
  onRemoveDraftContent,
  onClearError,
}: {
  pastedText?: string;
  pastedTextBytes: number;
  error?: string;
  attachmentError?: boolean;
  draftConflict?: ConversationDraftConflictDto;
  failedDraftContents: Array<{ id: string; name: string }>;
  onShowPastedText(): void;
  onRemovePastedText(): void;
  onRestoreDraft(): void;
  onDiscardDraft(): void;
  restoringDraft: boolean;
  mutationLocked: boolean;
  onRetryDraftContent(id: string): void;
  onRemoveDraftContent(id: string): void;
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
              disabled={mutationLocked}
              size="small"
              sx={{ p: 0, minWidth: 0, textTransform: "none" }}
              onClick={onShowPastedText}
            >
              View or edit
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {pastedTextBytes.toLocaleString()} bytes
          </Typography>
          <IconButton
            disabled={mutationLocked}
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
          {attachmentError ? error : `Message not sent. ${error}`}
        </Alert>
      ) : null}
      {failedDraftContents.map(item => (
        <Alert
          key={item.id}
          severity="warning"
          sx={{ mb: 1 }}
          action={
            <Stack direction="row" spacing={0.5}>
              <Button size="small" disabled={mutationLocked} onClick={() => onRetryDraftContent(item.id)}>
                Retry
              </Button>
              <Button size="small" disabled={mutationLocked} onClick={() => onRemoveDraftContent(item.id)}>
                Remove
              </Button>
            </Stack>
          }
        >
          {item.name} could not be restored from this draft.
        </Alert>
      ))}
      {draftConflict ? (
        <Alert
          severity="warning"
          sx={{ mb: 1 }}
          action={
            <Stack direction="row" spacing={0.5}>
              <Button size="small" disabled={restoringDraft || mutationLocked} onClick={onDiscardDraft}>
                Discard
              </Button>
              <Button size="small" disabled={restoringDraft || mutationLocked} onClick={onRestoreDraft}>
                {restoringDraft ? "Working…" : "Restore"}
              </Button>
            </Stack>
          }
        >
          This draft changed elsewhere. Your version is preserved.
          {draftConflict.displaced.text
            ? ` Text: “${compactPreviewText(draftConflict.displaced.text)}”`
            : ""}
          {draftConflict.displaced.pastedTextAttachmentId
            ? " It includes pasted text."
            : ""}
          {draftConflict.displaced.attachmentIds.length > 0
            ? ` It includes ${draftConflict.displaced.attachmentIds.length} attachment${draftConflict.displaced.attachmentIds.length === 1 ? "" : "s"}.`
            : ""}
          {!draftConflict.displaced.text &&
          !draftConflict.displaced.pastedTextAttachmentId &&
          draftConflict.displaced.attachmentIds.length === 0
            ? " It is an empty draft."
            : ""}
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
  mentionBindings,
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
  inlineDestination?: {
    handle: string;
    title: string;
    agentId?: string;
    onClear(): void;
  };
  mentionTokens: ComposerMentionDescriptor[];
  mentionBindings: AgentMentionBindingDto[];
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
        inlineDestination={inlineDestination}
        mentionDescriptors={mentionTokens}
        mentionBindings={mentionBindings}
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
  menuActions,
  buttonRef,
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
  menuActions?: ComposerMenuAction[];
  buttonRef?: RefObject<HTMLButtonElement>;
  visibleCapabilities: EngineComposerCapability[];
  onFiles(files: File[]): void;
  onOpen(anchor: HTMLElement): void;
  onClose(): void;
  onFilterChange(value: string): void;
  onApplyCapability(capability: EngineComposerCapability): void;
}): JSX.Element {
  const maximumFiles = assetLimits?.maxAssetsPerMessage ?? COMPOSER_MAX_FILES;
  const photoInput = useRef<HTMLInputElement>(null);
  const capabilityGroups = [
    { label: "Available skills", items: visibleCapabilities.filter(item => item.status === "available" && item.kind === "skill") },
    { label: "Installed plugins", items: visibleCapabilities.filter(item => item.status === "available" && item.kind === "plugin") },
    { label: "Connected apps", items: visibleCapabilities.filter(item => item.status === "available" && item.kind === "connector") },
    { label: "Unavailable options", items: visibleCapabilities.filter(item => item.status !== "available") },
  ].filter(group => group.items.length > 0);
  const mobile = useMediaQuery(useTheme().breakpoints.down("md"));
  const [browseCapabilities, setBrowseCapabilities] = useState(false);
  const showCapabilities = !mobile || browseCapabilities;
  const [popper, setPopper] = useState<{ update(): Promise<unknown> } | null>(null);
  useEffect(() => {
    if (!mobile || !menuAnchor || !popper) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { void popper.update(); });
    };
    // The iOS app frame resizes after VisualViewport events. Popper's default
    // window listener can measure the anchor before that layout has settled.
    const observer = new ResizeObserver(update);
    const root = document.getElementById("root");
    if (root) observer.observe(root);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [mobile, menuAnchor, popper]);
  return (
    <>
      <input
        ref={fileInput}
        aria-label="Choose files"
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp,image/heic,image/heif,image/gif,image/avif,.jpg,.jpeg,.png,.webp,.heic,.heif,.gif,.avif,application/pdf,text/plain,application/json,application/zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,.md,.csv,.log,.json,.zip,.pdf,.docx"
        multiple
        onChange={event => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <input
        ref={photoInput}
        aria-label="Choose photos"
        hidden
        type="file"
        accept="image/*"
        multiple
        onChange={event => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Tooltip title={mobile ? "" : "Add an image, file, skill, plugin, or connector"}>
        <span>
          <IconButton
            ref={buttonRef}
            aria-label="Add attachment or capability"
            aria-haspopup="menu"
            aria-expanded={Boolean(menuAnchor)}
            aria-controls={menuAnchor ? listId : undefined}
            disabled={disabled}
            onClick={event => {
              setBrowseCapabilities(false);
              onOpen(event.currentTarget);
            }}
          >
            <AddIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Popper
        popperRef={setPopper}
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
              width: mobile ? "min(340px, calc(100vw - 24px))" : "min(420px, calc(100vw - 24px))",
              maxHeight: mobile ? "min(390px, calc(var(--ponderosa-app-viewport-block-size, 100dvh) - 80px))" : "min(52vh, 390px)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
            onKeyDown={event => {
              if (event.key === "Escape") {
                onClose();
                menuAnchor?.focus({ preventScroll: true });
              }
            }}
          >
            {showCapabilities && <Box sx={{ p: 1, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
              {mobile && <Button size="small" onClick={() => { setBrowseCapabilities(false); onFilterChange(""); }}>← Back</Button>}
              <TextField
                autoFocus={!mobile}
                fullWidth
                size="small"
                value={filter}
                onChange={event => onFilterChange(event.target.value)}
                placeholder={mobile ? "Search skills & connectors" : "Find a skill, plugin, or connector"}
                inputProps={{ "aria-label": "Filter runtime capabilities" }}
                sx={isIOSDevice() ? { "& input": { fontSize: 16 } } : undefined}
              />
            </Box>}
            <MenuList
              dense
              id={listId}
              aria-label="Add attachment or runtime capability"
              sx={{
                maxHeight: mobile ? 260 : "min(38vh, 300px)",
                minHeight: 0,
                overflowY: "auto",
                overscrollBehavior: "contain",
              }}
            >
              {(!mobile || !browseCapabilities) && <ListSubheader sx={{ lineHeight: "32px", bgcolor: "background.paper", fontWeight: 800 }}>Attachments</ListSubheader>}
              {(!mobile || !browseCapabilities) && ["Photos", "Files"].map(label => <MenuItem
                key={label}
                disabled={!attachmentsEnabled || fileCount >= maximumFiles}
                onClick={() => {
                  onClose();
                  (label === "Photos" ? photoInput : fileInput).current?.click();
                }}
                sx={{
                  whiteSpace: "normal",
                  alignItems: "flex-start",
                  minHeight: 54,
                }}
              >
                <Box>
                  <Typography variant="body2">{label}</Typography>
                  {(!mobile || !attachmentsEnabled || fileCount >= maximumFiles) && <Typography variant="caption" color="text.secondary">
                    {!attachmentsEnabled
                      ? (attachmentsUnavailableReason ??
                        "Attachments are not supported in this chat.")
                      : fileCount >= maximumFiles
                        ? "Remove an attachment before adding another."
                        : label === "Photos"
                          ? `PNG, JPEG, WebP, HEIC, GIF, or AVIF · ${Math.floor((assetLimits?.maxFileBytes ?? COMPOSER_MAX_FILE_BYTES) / 1024 / 1024)} MiB each`
                          : `Up to ${maximumFiles} images, PDF, DOCX, text, JSON, or ZIP files · ${Math.floor((assetLimits?.maxFileBytes ?? COMPOSER_MAX_FILE_BYTES) / 1024 / 1024)} MiB each`}
                  </Typography>}
                </Box>
              </MenuItem>)}
              {!browseCapabilities && menuActions?.map(action => <MenuItem
                key={action.id}
                disabled={action.disabled}
                onClick={() => {
                  const trigger = menuAnchor;
                  onClose();
                  trigger?.focus({ preventScroll: true });
                  action.onSelect();
                }}
                sx={{ minHeight: mobile ? 48 : 46, gap: 1, whiteSpace: "normal" }}
              >
                {action.icon ? <Box aria-hidden sx={{ display: "flex", color: "text.secondary" }}>{action.icon}</Box> : null}
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2">{action.label}</Typography>
                  {action.description ? <Typography variant="caption" color="text.secondary" sx={{ display: "block", overflowWrap: "anywhere" }}>
                    {action.description}
                  </Typography> : null}
                </Box>
              </MenuItem>)}
              {mobile && !browseCapabilities && <MenuItem sx={{ minHeight: 48 }} onClick={() => setBrowseCapabilities(true)}>Skills &amp; connectors</MenuItem>}
              {!mobile && <Divider />}
              {showCapabilities && ((capabilities ?? []).length === 0 ? (
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
                capabilityGroups.flatMap(group => [
                  <ListSubheader key={`heading:${group.label}`} sx={{ lineHeight: "32px", bgcolor: "background.paper", fontWeight: 800 }}>{group.label}</ListSubheader>,
                  ...group.items.map(capability => {
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
                        minHeight: mobile ? 48 : 58,
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
                            {capabilityDisplayName(capability)}
                          </Typography>
                          <Chip
                            size="small"
                            variant="outlined"
                            color={automatic ? "success" : "default"}
                            label={capability.kind}
                          />
                        </Stack>
                        {!mobile && <Typography
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
                        </Typography>}
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
                  }),
                ])
              ))}
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
  | { kind: "file"; entry: ArtifactDto };

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
                  : "Project Files & Results"
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
                        ? suggestion.entry.id
                        : suggestion.command.name
                  }
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={index === highlighted}
                  selected={index === highlighted}
                  disabled={Boolean(commandReason)}
                  sx={{ whiteSpace: "normal", alignItems: "flex-start" }}
                  onMouseDown={event => event.preventDefault()}
                  onClick={event => {
                    event.stopPropagation();
                    onSelect(suggestion);
                  }}
                >
                  {suggestion.kind === "mention" ? (
                    `#${suggestion.handle}`
                  ) : suggestion.kind === "file" ? (
                    <Box>
                      <Typography variant="body2">
                        @{suggestion.entry.path}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Files &amp; Results · {suggestion.entry.kind}
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
