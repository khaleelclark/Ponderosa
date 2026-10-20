import CheckIcon from "@mui/icons-material/Check";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import SpeedOutlinedIcon from "@mui/icons-material/SpeedOutlined";
import {
  Box,
  ButtonBase,
  ClickAwayListener,
  IconButton,
  ListSubheader,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  type PopperProps,
  Slider,
  Stack,
  Tooltip,
  useTheme,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface ComposerRuntimeOption {
  id: string;
  label: string;
  disabled?: boolean;
  detail?: string;
  group?: "Latest" | "Pinned";
}

function effortLabel(option?: ComposerRuntimeOption): string | undefined {
  return option?.id === "xhigh" ? "Extra High" : option?.label.replace(/\b\p{L}/gu, letter => letter.toLocaleUpperCase());
}

// The same palette drives the trigger and the open slider label.
export function effortPresentation(index: number, count: number, dark: boolean) {
  const ratio = count > 1 ? Math.max(0, index) / (count - 1) : 0;
  const mix = (from: number[], to: number[], amount: number) => `rgb(${from.map((v, i) => Math.round(v + (to[i]! - v) * amount)).join(" ")})`;
  const end = ratio <= 0.5
    ? mix([183, 244, 206], [34, 229, 138], ratio * 2)
    : mix([34, 229, 138], [0, 83, 47], (ratio - 0.5) * 2);
  return {
    ratio,
    ultra: count > 1 && index === count - 1,
    color: dark ? mix([172, 220, 192], [57, 235, 144], ratio) : mix([51, 110, 78], [8, 96, 54], ratio),
    gradient: ratio > 0.5
      ? `linear-gradient(90deg, #b7f4ce, #22e58a 42%, ${end} 78%, ${end})`
      : `linear-gradient(90deg, #b7f4ce, ${end})`,
  };
}

// Keep these stable when the instance ref is registered; recreating them on
// each render would destroy and recreate the Popper instance repeatedly.
const runtimePopperModifiers: PopperProps["modifiers"] = [
  { name: "offset", options: { offset: [0, 8] } },
  { name: "preventOverflow", options: { padding: 12 } },
  { name: "flip", options: { fallbackPlacements: ["top-start", "bottom-end"] } },
];

export function ComposerRuntimeSelector({
  engine,
  engines,
  model,
  models,
  effort,
  efforts,
  speed,
  speeds = [],
  scopeLabel,
  selectionKey,
  engineLocked = false,
  disabled = false,
  loading = false,
  onEngineChange,
  onModelChange,
  onEffortChange,
  onSpeedChange,
  onReset,
}: {
  engine: string;
  engines: ComposerRuntimeOption[];
  model: string;
  models: ComposerRuntimeOption[];
  effort: string;
  efforts: ComposerRuntimeOption[];
  speed?: string;
  speeds?: ComposerRuntimeOption[];
  /** Owner shown when the selector opens, such as a Chat or Agent. */
  scopeLabel?: string;
  /** Stable owner identity; display names do not own pending input. */
  selectionKey: string;
  engineLocked?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onEngineChange?(id: string): void;
  onModelChange(id: string): void;
  onEffortChange(id: string): void;
  onSpeedChange?(id: string): void;
  onReset(): void;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [section, setSection] = useState<"engine" | "model" | "speed" | null>(null);
  const [preview, setPreview] = useState<{ key: string; index: number } | null>(null);
  const [pageVisible, setPageVisible] = useState(true);
  const theme = useTheme();
  const catalogKey = JSON.stringify([selectionKey, engine, model, efforts, effort, disabled, loading, Boolean(anchor)]);
  const interaction = useRef({ key: catalogKey, revision: 0 });
  if (interaction.current.key !== catalogKey) interaction.current = { key: catalogKey, revision: interaction.current.revision + 1 };
  const interactionRevision = interaction.current.revision;
  const gestureRevision = useRef<number | null>(null);
  const selectedIndex = efforts.findIndex(option => option.id === effort);
  const index = preview?.key === catalogKey ? preview.index : selectedIndex;
  const presentation = effortPresentation(index, efforts.length, theme.palette.mode === "dark");
  useEffect(() => { setPreview(null); }, [catalogKey, effort, anchor]);
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === "visible");
    update(); document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const preserveEditorFocus = useRef(false);
  const editorFocus = useRef<{ element: HTMLElement; range: Range | null } | null>(null);
  const resumeFocus = useRef<HTMLElement | null>(null);
  const rememberPickerFocus = () => {
    if (!preserveEditorFocus.current && document.getElementById(menuId)?.contains(document.activeElement)) {
      resumeFocus.current = document.activeElement as HTMLElement;
    }
  };
  const keepKeyboard = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") {
      if (!anchor) preserveEditorFocus.current = false;
      return;
    }
    if (!anchor) preserveEditorFocus.current = Boolean(
      document.activeElement?.closest('[contenteditable="true"], textarea, input'),
    );
    if (preserveEditorFocus.current && document.activeElement instanceof HTMLElement && document.activeElement.closest('[contenteditable="true"], textarea, input')) {
      const selection = document.getSelection();
      editorFocus.current = { element: document.activeElement, range: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null };
    }
    // Prevent the compatibility mouse-down focus below, not pointer-down:
    // cancelling a touch pointer-down also suppresses clicks in WebKit.
  };
  const [popper, setPopper] = useState<{ update(): Promise<unknown> } | null>(null);
  useEffect(() => {
    if (!anchor || !popper) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { void popper.update(); });
    };
    // The app height settles after the resize event. Reposition after that
    // layout, rather than retaining Popper's first, pre-resize measurement.
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    const root = document.getElementById("root");
    if (root) observer.observe(root);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [anchor, popper]);
  const menuId = useId();
  const focusPicker = useCallback((node: HTMLDivElement | null) => {
    if (node && !preserveEditorFocus.current) node.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
  }, []);
  const selectedEngine = engines.find((option) => option.id === engine);
  const selectedModel = models.find((option) => option.id === model);
  const selectedEffort = efforts.find((option) => option.id === effort);
  const selectedSpeed = speeds.find(option => option.id === speed);
  const selectedModelLabel = loading ? "Loading model…" : selectedModel?.label ?? (models.length ? "Choose model" : "Choose a provider");
  const selectedEffortLabel = loading ? "Loading reasoning…" : effortLabel(selectedEffort) ?? (efforts.length ? "Choose reasoning" : "Reasoning follows model");
  const close = useCallback(() => {
    if (!preserveEditorFocus.current && document.getElementById(menuId)?.contains(document.activeElement)) anchor?.focus();
    setAnchor(null); setSection(null); setPreview(null); resumeFocus.current = null;
  }, [anchor, menuId]);
  useEffect(() => {
    if (!anchor) return;
    // Touch keeps focus in the editor, outside the menu. Own Escape in capture
    // so dismissing this picker cannot reach the editor's recipient removal.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      if (section) { setSection(null); if (!preserveEditorFocus.current) (section === "engine" ? engineButton : modelButton).current?.focus(); }
      else close();
    };
    const document = anchor.ownerDocument;
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [anchor, close, section]);
  useEffect(() => {
    if (disabled) setPreview(null);
    else if (resumeFocus.current) {
      if (anchor && resumeFocus.current.isConnected && document.activeElement === document.body) resumeFocus.current.focus({ preventScroll: true });
      resumeFocus.current = null;
    }
  }, [disabled]);
  const canSwitchEngine = !engineLocked && Boolean(onEngineChange) && engines.length > 1;
  const modelButton = useRef<HTMLButtonElement>(null);
  const engineButton = useRef<HTMLButtonElement>(null);
  const activeOptions = section === "engine" ? engines : section === "speed" ? speeds : models;
  const activeValue = section === "engine" ? engine : section === "speed" ? speed : model;
  const fast = Boolean(selectedSpeed && selectedSpeed.id !== "standard");
  const fastOption = speeds.find(option => option.id !== "standard");
  const speedTitle = speeds.length === 2
    ? `${selectedEngine?.label ?? ""} ${fastOption?.label ?? "Fast"} mode ${fast ? "on" : "off"}.${fastOption?.detail ? ` ${fastOption.detail}` : ""}`
    : `${selectedSpeed?.label ?? "Speed"}${selectedSpeed?.detail ? `. ${selectedSpeed.detail}` : ""}`;
  const commitEffort = (event: Event | React.SyntheticEvent, value: number | number[]) => {
    const keyboard = event.type === "change" || event.type === "keydown";
    const startedAt = keyboard ? null : gestureRevision.current;
    if (!keyboard) gestureRevision.current = null;
    if (!anchor || interaction.current.revision !== interactionRevision || (startedAt !== null && startedAt !== interactionRevision) || disabled || loading) { setPreview(null); return; }
    const next = efforts[Number(value)];
    setPreview(null);
    if (next && !next.disabled && next.id !== effort) { rememberPickerFocus(); onEffortChange(next.id); }
  };
  const choose = (id: string) => {
    if (disabled || loading) return;
    if (id !== activeValue) {
      if (!preserveEditorFocus.current) resumeFocus.current = (section === "engine" ? engineButton : modelButton).current;
      if (section === "engine") onEngineChange?.(id);
      else if (section === "speed") onSpeedChange?.(id);
      else onModelChange(id);
    }
    setPreview(null); setSection(null);
    if (!preserveEditorFocus.current) (section === "engine" ? engineButton : modelButton).current?.focus();
  };

  const optionList = section ? <MenuList autoFocusItem={!preserveEditorFocus.current} disablePadding aria-label={`${section} options`} sx={{ maxHeight: 240, overflowY: "auto", scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" }, bgcolor: "action.hover", borderRadius: 1.5 }}>
            {activeOptions.flatMap((option, optionIndex) => [
              ...(option.group && option.group !== activeOptions[optionIndex - 1]?.group ? [<ListSubheader key={option.group} disableSticky sx={{ bgcolor: "transparent", lineHeight: "30px" }}>{option.group}</ListSubheader>] : []),
              <MenuItem key={option.id} selected={option.id === activeValue} disabled={disabled || loading || option.disabled} onClick={() => choose(option.id)} sx={{ minHeight: 44, whiteSpace: "normal", gap: 1 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{option.label}</Typography>{option.detail && (section !== "model" || option.disabled) ? <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.35, overflowWrap: "anywhere" }}>{option.detail}</Typography> : null}</Box>
                {option.id === activeValue ? <CheckIcon fontSize="small" /> : null}
              </MenuItem>,
            ])}
          </MenuList> : null;

  return <>
    <ButtonBase
      aria-label={`${scopeLabel ? `${scopeLabel}. ` : ""}Choose engine, model, reasoning, and speed`}
      aria-haspopup="dialog"
      aria-controls={anchor ? menuId : undefined}
      aria-expanded={Boolean(anchor)}
      disabled={disabled}
      onPointerDown={keepKeyboard}
      onMouseDown={event => { if (preserveEditorFocus.current) event.preventDefault(); }}
      onClick={(event) => {
        if (event.detail === 0) preserveEditorFocus.current = false;
        if (anchor) {
          close();
          return;
        }
        setAnchor(event.currentTarget);
        setSection(null);
      }}
      sx={{
        minHeight: 40,
        minWidth: { xs: 44, sm: 0 },
        maxWidth: "100%",
        px: { xs: 0.5, sm: 1 },
        borderRadius: 1.25,
        color: "text.primary",
        "&:hover": { bgcolor: "action.hover" },
        "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
      }}
    >
      <SpeedOutlinedIcon sx={{ display: { xs: "block", sm: "none" } }} />
      <Stack direction="row" spacing={0.6} sx={{ display: { xs: "none", sm: "flex" }, alignItems: "baseline", minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 700 }}>{selectedModelLabel}</Typography>
        <Typography
          variant="body2"
          noWrap
          sx={{ color: effortPresentation(selectedIndex, efforts.length, theme.palette.mode === "dark").color, display: { xs: "none", sm: "block" } }}
        >
          · {selectedEffortLabel}
        </Typography>
        {selectedSpeed && selectedSpeed.id !== "standard" ? (
          <Typography variant="body2" color="text.secondary" noWrap>· {selectedSpeed.label}</Typography>
        ) : null}
        <KeyboardArrowDownIcon sx={{ alignSelf: "center", color: "text.secondary", fontSize: 20 }} />
      </Stack>
    </ButtonBase>
    <Popper
      role="presentation"
      popperRef={setPopper}
      open={Boolean(anchor)}
      anchorEl={anchor}
      placement="top-end"
      modifiers={runtimePopperModifiers}
      sx={{ zIndex: 1500 }}
    >
      <ClickAwayListener onClickAway={event => {
        // The trigger owns toggling. Touch-end click-away must not close it
        // before the subsequent click toggles the same menu open again.
        if (event.target instanceof Node && anchor?.contains(event.target)) return;
        close();
      }}>
        <Paper
          id={menuId}
          ref={focusPicker}
          role="dialog"
          aria-label={scopeLabel ?? "Runtime settings"}
          onPointerDown={keepKeyboard}
          onMouseDown={event => { if (preserveEditorFocus.current) event.preventDefault(); }}
          elevation={12}
          sx={{
            width: 286,
            maxWidth: "calc(100vw - 24px)",
            maxHeight: "min(520px, calc(var(--ponderosa-app-viewport-block-size, 100dvh) - 80px))",
            overflowX: "hidden",
            overflowY: "auto",
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": { display: "none" },
            overscrollBehavior: "contain",
            p: 1,
            border: 1,
            borderColor: "divider",
            borderRadius: 2.5,
            bgcolor: "background.paper",
          }}
        >
          {scopeLabel ? <Tooltip title={scopeLabel} enterTouchDelay={0}>
            <Stack direction="row" justifyContent="center" aria-label={scopeLabel} sx={{ minWidth: 0, px: 1, pb: 0.25, fontWeight: 700, fontSize: 13 }}>
              <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{scopeLabel.replace(/ Next Run$/, "")}</Box>
              <Box component="span" sx={{ whiteSpace: "nowrap", flexShrink: 0 }}> Next Run</Box>
            </Stack>
          </Tooltip> : null}
          <ButtonBase ref={engineButton}
            disabled={disabled || !canSwitchEngine || loading}
            aria-label={`Engine: ${selectedEngine?.label ?? engine}`}
            aria-expanded={section === "engine"}
            onClick={() => setSection(section === "engine" ? null : "engine")}
            sx={{ display: "flex", width: "100%", justifyContent: "space-between", px: 1.25, borderRadius: 1.5, minHeight: { xs: 44, sm: 34 }, "@media (pointer: coarse)": { minHeight: 44 }, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" } }}
          >
            <Typography variant="body2">Engine</Typography>
            <Stack direction="row" spacing={0.5} alignItems="center"><Typography variant="body2">{selectedEngine?.label ?? engine}</Typography>{canSwitchEngine ? <KeyboardArrowDownIcon fontSize="small" /> : null}</Stack>
          </ButtonBase>
          {section === "engine" ? optionList : null}
          <Box sx={{ mx: 2, height: 48, position: "relative" }}>
            <Box aria-hidden sx={{ position: "absolute", inset: "12px 0", borderRadius: 20, bgcolor: "action.disabledBackground", boxShadow: presentation.ultra ? "0 0 18px #22e58a22" : "none" }}>
              {index >= 0 ? <Box className="runtime-effort-fill" sx={{ position: "relative", height: "100%", width: `calc(24px + (100% - 24px) * ${presentation.ratio})`, borderRadius: 20, overflow: "hidden", background: fast ? "linear-gradient(90deg, #2c8060, #0b4835, #02180f)" : presentation.gradient,
                "&::before": { content: '\'\'', position: "absolute", inset: 0, opacity: fast ? 1 : presentation.ultra ? 0.5 : 0, background: "radial-gradient(circle at 8% 27%, #d9ffecb3 0 .7px, transparent 1.2px), radial-gradient(circle at 40% 65%, #d9ffecd9 0 .8px, transparent 1.3px), radial-gradient(circle at 71% 22%, #d9ffecb3 0 .7px, transparent 1.2px), radial-gradient(circle at 90% 63%, #d9ffecd9 0 .8px, transparent 1.3px)" },
                "@keyframes runtime-speed-flow": { "0%": { transform: "translateX(105%)", opacity: 0 }, "12%, 80%": { opacity: 0.85 }, "100%": { transform: "translateX(-100%)", opacity: 0 } },
                "& > span": { position: "absolute", left: 0, right: 0, height: "1.5px", background: "linear-gradient(90deg, transparent 45%, #ffffff9e 84%, #ffffffed 91%, transparent 96%)", opacity: 0, animation: fast ? "runtime-speed-flow 1050ms linear infinite" : "none", animationPlayState: pageVisible && anchor ? "running" : "paused", "@media (prefers-reduced-motion: reduce)": { animation: "none" } },
              }}>{[0, 1, 2].map(i => <Box component="span" key={i} sx={{ top: 5 + i * 6, animationDelay: `${-350 * i}ms` }} />)}</Box> : null}
            </Box>
            <Slider
              aria-label="Reasoning effort"
              getAriaValueText={value => effortLabel(efforts[value]) ?? "Unavailable"}
              value={Math.max(0, index)} min={0} max={Math.max(1, efforts.length - 1)} step={null}
              marks={efforts.map((_option, value) => ({ value }))}
              disabled={disabled || loading || efforts.length < 2 || index < 0}
              onPointerDownCapture={() => { gestureRevision.current = interactionRevision; }}
              onChange={(event, value) => {
                if (event.type !== "change" && event.type !== "keydown" && gestureRevision.current !== null && gestureRevision.current !== interactionRevision) return;
                setPreview({ key: catalogKey, index: Number(value) });
              }}
              onChangeCommitted={commitEffort}
              onPointerCancel={() => { gestureRevision.current = -1; setPreview(null); }}
              onFocusCapture={() => {
                // MUI directly focuses the thumb on touch, bypassing mouse-down.
                // Restore the existing editor selection without cancelling drag.
                const saved = editorFocus.current;
                if (!preserveEditorFocus.current || !saved?.element.isConnected) return;
                saved.element.focus({ preventScroll: true });
                if (saved.range) { const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(saved.range); }
              }}
              track={false}
              sx={{ position: "absolute", left: 24, width: "calc(100% - 24px)", height: 24, py: "12px", top: 0,
                "& .MuiSlider-rail": { opacity: 0 },
                "& .MuiSlider-mark": { height: 3, width: 3, borderRadius: "50%", bgcolor: "text.secondary", opacity: 0.6 },
                "& .MuiSlider-thumb": { height: 28, width: 28, bgcolor: "#fff", boxShadow: "0 1px 6px #0003", "&.Mui-focusVisible": { boxShadow: "0 0 0 4px #22e58a66" } },
              }}
            />
          </Box>
          <Box sx={{ display: "grid", gridTemplateColumns: "44px minmax(0, 1fr) 44px", alignItems: "start", px: 0.5 }}>
            {speeds.length > 1 && onSpeedChange ? <Tooltip title={speedTitle} enterTouchDelay={0}>
              <IconButton aria-label={speedTitle} aria-pressed={fast} aria-expanded={speeds.length > 2 ? section === "speed" : undefined} disabled={disabled || loading}
                onClick={() => {
                  if (speeds.length > 2) setSection(section === "speed" ? null : "speed");
                  else { rememberPickerFocus(); const next = speeds.find(option => option.id !== selectedSpeed?.id); if (next && !next.disabled) onSpeedChange(next.id); }
                }} sx={{ gridColumn: 1, width: 44, height: 44, color: fast ? "primary.main" : "text.secondary", bgcolor: fast ? "action.selected" : "transparent" }}><SpeedOutlinedIcon fontSize="small" /></IconButton>
            </Tooltip> : null}
            <ButtonBase ref={modelButton} aria-label={`Model: ${selectedModelLabel}`} aria-expanded={section === "model"} disabled={disabled || loading || !models.length}
              onClick={() => setSection(section === "model" ? null : "model")}
              sx={{ gridColumn: 2, gridRow: 1, minWidth: 0, width: "100%", minHeight: 64, pt: 1.25, pb: 1, display: "flex", flexDirection: "column", borderRadius: 1.25, "&:hover": { bgcolor: "action.hover" }, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" } }}>
              <Typography noWrap sx={{ maxWidth: "100%", color: presentation.color, fontWeight: presentation.ultra ? 800 : 600, textShadow: presentation.ultra && theme.palette.mode === "dark" ? "0 0 13px #22e58a38" : "none" }}>{preview?.key === catalogKey ? effortLabel(efforts[index]) : selectedEffortLabel}</Typography>
              <Stack direction="row" alignItems="center" sx={{ maxWidth: "100%", minWidth: 0, color: "text.secondary" }}><Typography variant="body2" noWrap>{selectedModelLabel}</Typography><KeyboardArrowDownIcon sx={{ fontSize: 16, flexShrink: 0 }} /></Stack>
            </ButtonBase>
            <Tooltip title="Reset to default" enterTouchDelay={0}><IconButton aria-label="Reset to default" disabled={disabled || loading || !models.length} onClick={() => { rememberPickerFocus(); setPreview(null); setSection(null); onReset(); }} sx={{ gridColumn: 3, gridRow: 1, width: 44, height: 44 }}><RestartAltIcon fontSize="small" /></IconButton></Tooltip>
          </Box>
          {section !== "engine" ? optionList : null}
        </Paper>
      </ClickAwayListener>
    </Popper>
  </>;
}
