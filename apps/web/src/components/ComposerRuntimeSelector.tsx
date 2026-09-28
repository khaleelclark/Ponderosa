import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckIcon from "@mui/icons-material/Check";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import SpeedOutlinedIcon from "@mui/icons-material/SpeedOutlined";
import {
  Box,
  ButtonBase,
  ClickAwayListener,
  Divider,
  ListSubheader,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useId, useState } from "react";

export interface ComposerRuntimeOption {
  id: string;
  label: string;
  disabled?: boolean;
  detail?: string;
  group?: "Latest" | "Pinned";
}

type RuntimeSection = "engine" | "model" | "effort" | "speed";

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
  engineLocked = false,
  disabled = false,
  loading = false,
  onEngineChange,
  onModelChange,
  onEffortChange,
  onSpeedChange,
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
  engineLocked?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onEngineChange?(id: string): void;
  onModelChange(id: string): void;
  onEffortChange(id: string): void;
  onSpeedChange?(id: string): void;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [section, setSection] = useState<RuntimeSection | null>(null);
  const menuId = useId();
  const selectedEngine = engines.find((option) => option.id === engine);
  const selectedModel = models.find((option) => option.id === model);
  const selectedEffort = efforts.find((option) => option.id === effort);
  const selectedSpeed = speeds.find(option => option.id === speed);
  const selectedModelLabel = loading ? "Loading model…" : selectedModel?.label ?? (models.length ? "Choose model" : "Choose a provider");
  const selectedEffortLabel = loading ? "Loading reasoning…" : selectedEffort?.label ?? (efforts.length ? "Choose reasoning" : "Reasoning follows model");
  const close = () => { setAnchor(null); setSection(null); };
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  const canSwitchEngine = !engineLocked && Boolean(onEngineChange) && engines.length > 1;
  const sections: Array<{
    id: RuntimeSection;
    label: string;
    value: string;
    options: ComposerRuntimeOption[];
  }> = [
    ...(canSwitchEngine
      ? [{ id: "engine" as const, label: "Engine", value: selectedEngine?.label ?? "Engine", options: engines }]
      : []),
    { id: "model", label: "Model", value: selectedModelLabel, options: models },
    { id: "effort", label: "Reasoning", value: selectedEffortLabel, options: efforts },
    ...(speeds.length > 0 && onSpeedChange
      ? [{
          id: "speed" as const,
          label: "Speed",
          value: selectedSpeed?.label ?? speeds[0]?.label ?? "Normal",
          options: speeds,
        }]
      : []),
  ];
  const active = sections.find((item) => item.id === section);
  const select = (id: string) => {
    if (section === "engine") onEngineChange?.(id);
    if (section === "model") onModelChange(id);
    if (section === "effort") onEffortChange(id);
    if (section === "speed") onSpeedChange?.(id);
    if (section === "effort" || section === "speed") close();
    else setSection(null);
  };

  return <>
    <ButtonBase
      aria-label={`${scopeLabel ? `${scopeLabel}. ` : ""}Choose engine, model, reasoning, and speed`}
      aria-haspopup="menu"
      aria-controls={anchor ? menuId : undefined}
      aria-expanded={Boolean(anchor)}
      disabled={disabled}
      onClick={(event) => {
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
          color="text.secondary"
          noWrap
          sx={{ display: { xs: "none", sm: "block" } }}
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
      open={Boolean(anchor)}
      anchorEl={anchor}
      placement="top-end"
      modifiers={[
        { name: "offset", options: { offset: [0, 8] } },
        { name: "preventOverflow", options: { padding: 12 } },
        { name: "flip", options: { fallbackPlacements: ["top-start", "bottom-end"] } },
      ]}
      sx={{ zIndex: 1500 }}
    >
      <ClickAwayListener onClickAway={close}>
        <Paper
          id={menuId}
          role="menu"
          elevation={12}
          sx={{
            width: 286,
            maxWidth: "calc(100vw - 24px)",
            maxHeight: "min(62vh, 520px)",
            overflowX: "hidden",
            overflowY: "auto",
            overscrollBehavior: "contain",
            p: 0.75,
            border: 1,
            borderColor: "divider",
            borderRadius: 2.5,
            bgcolor: "background.paper",
          }}
        >
          {scopeLabel ? <ListSubheader
            disableSticky
            sx={{ bgcolor: "transparent", color: "text.secondary", lineHeight: "32px", fontWeight: 800, px: 1.5 }}
          >{scopeLabel}</ListSubheader> : null}
          {active ? (
            <>
              <MenuItem
                onClick={() => setSection(null)}
                sx={{ minHeight: 46, borderRadius: 1.5, gap: 1 }}
              >
                <ArrowBackIcon fontSize="small" />
                <Typography sx={{ flex: 1, fontWeight: 700 }}>{active.label}</Typography>
              </MenuItem>
              <Divider sx={{ my: 0.5 }} />
              <MenuList
                autoFocusItem
                disablePadding
                aria-label={`${active.label} options`}
                sx={{
                  maxHeight: "min(50vh, 430px)",
                  overflowY: "auto",
                  overflowX: "hidden",
                  overscrollBehavior: "contain",
                }}
              >
                {active.options.flatMap((option, optionIndex) => {
                  const current =
                    active.id === "engine"
                      ? engine
                      : active.id === "model"
                        ? model
                        : active.id === "effort"
                          ? effort
                          : speed;
                  const showGroup = option.group && option.group !== active.options[optionIndex - 1]?.group;
                  const showDetail = Boolean(
                    option.detail &&
                    (active.id === "engine" ||
                      active.id === "speed" ||
                      option.disabled),
                  );
                  return [
                    ...(showGroup ? [
                      <ListSubheader
                        key={`${active.id}-group-${option.group}`}
                        disableSticky
                        sx={{
                          bgcolor: "transparent",
                          color: "text.secondary",
                          lineHeight: "30px",
                          fontWeight: 800,
                          px: 1.5,
                        }}
                      >
                        {option.group}
                      </ListSubheader>,
                    ] : []),
                    <MenuItem
                      key={`${active.id}-${option.id || "default"}`}
                      disabled={option.disabled}
                      selected={option.id === current}
                      onClick={() => select(option.id)}
                      sx={{
                        minHeight: showDetail ? 52 : 40,
                        borderRadius: 1.5,
                        px: 1.5,
                        py: showDetail ? 0.75 : 0.5,
                        gap: 1,
                        alignItems: "flex-start",
                        whiteSpace: "normal",
                      }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ overflowWrap: "anywhere" }}>
                          {option.label}
                        </Typography>
                        {showDetail ? (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: "block", lineHeight: 1.35, overflowWrap: "anywhere" }}
                          >
                            {option.detail}
                          </Typography>
                        ) : null}
                      </Box>
                      {option.id === current ? <CheckIcon fontSize="small" sx={{ mt: 0.25 }} /> : null}
                    </MenuItem>,
                  ];
                })}
              </MenuList>
            </>
          ) : (
            <>
              <Box sx={{ px: 1.25, pt: 0.75, pb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Runtime
                </Typography>
              </Box>
              <MenuList disablePadding aria-label="Runtime settings">
                {sections.map((item) => (
                  <MenuItem
                    key={item.id}
                    disabled={item.options.length === 0}
                    onClick={() => setSection(item.id)}
                    sx={{ minHeight: 46, borderRadius: 1.5, px: 1.25, gap: 1 }}
                  >
                    <Typography sx={{ flex: 1 }}>{item.label}</Typography>
                    <Typography color="text.secondary" noWrap sx={{ maxWidth: 132 }}>
                      {item.value}
                    </Typography>
                    <ChevronRightIcon fontSize="small" sx={{ color: "text.secondary" }} />
                  </MenuItem>
                ))}
              </MenuList>
            </>
          )}
        </Paper>
      </ClickAwayListener>
    </Popper>
  </>;
}
