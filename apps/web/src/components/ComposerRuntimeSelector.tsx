import CheckIcon from "@mui/icons-material/Check";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
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
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useId, useState } from "react";

export interface ComposerRuntimeOption {
  id: string;
  label: string;
  disabled?: boolean;
  detail?: string;
  group?: "Latest" | "Pinned";
}

type RuntimeSection = "engine" | "model" | "effort";

export function ComposerRuntimeSelector({
  engine,
  engines,
  model,
  models,
  resolvedModel,
  effort,
  efforts,
  engineLocked = false,
  onEngineChange,
  onModelChange,
  onEffortChange,
}: {
  engine: string;
  engines: ComposerRuntimeOption[];
  model: string;
  models: ComposerRuntimeOption[];
  resolvedModel?: string;
  effort: string;
  efforts: ComposerRuntimeOption[];
  engineLocked?: boolean;
  onEngineChange?(id: string): void;
  onModelChange(id: string): void;
  onEffortChange(id: string): void;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [section, setSection] = useState<RuntimeSection | null>(null);
  const menuId = useId();
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down("sm"));
  const selectedEngine = engines.find((option) => option.id === engine);
  const selectedModel = models.find((option) => option.id === model);
  const selectedEffort = efforts.find((option) => option.id === effort);
  const selectedModelLabel = selectedModel?.label ?? "Model unavailable";
  const displayedModel = resolvedModel && resolvedModel !== model
    ? `${selectedModelLabel} → ${resolvedModel}`
    : selectedModelLabel;
  const close = () => { setAnchor(null); setSection(null); };
  const sections: Array<{
    id: RuntimeSection;
    label: string;
    value: string;
    options: ComposerRuntimeOption[];
    locked?: boolean;
  }> = [
    { id: "engine", label: "Engine", value: selectedEngine?.label ?? "Engine", options: engines, locked: engineLocked || !onEngineChange },
    { id: "model", label: "Model", value: displayedModel, options: models },
    { id: "effort", label: "Effort", value: selectedEffort?.label ?? "Effort unavailable", options: efforts },
  ];
  const active = sections.find((item) => item.id === section);
  const select = (id: string) => {
    if (section === "engine") onEngineChange?.(id);
    if (section === "model") onModelChange(id);
    if (section === "effort") onEffortChange(id);
    close();
  };

  return <>
    <ButtonBase
      aria-label="Choose engine, model, and effort"
      aria-haspopup="menu"
      aria-controls={anchor ? menuId : undefined}
      aria-expanded={Boolean(anchor)}
      onClick={(event) => { setAnchor(event.currentTarget); setSection(null); }}
      sx={{
        minHeight: 40,
        maxWidth: "100%",
        px: 1,
        borderRadius: 1.25,
        color: "text.primary",
        "&:hover": { bgcolor: "action.hover" },
        "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
      }}
    >
      <Stack direction="row" spacing={0.6} sx={{ alignItems: "baseline", minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 700 }}>{selectedEngine?.label ?? "Engine"}</Typography>
        <Typography variant="body2" noWrap>{displayedModel}</Typography>
        <Typography variant="body2" color="text.secondary" noWrap>{selectedEffort?.label ?? "Effort unavailable"}</Typography>
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
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "flex-end" }}>
          {(!compact || !section) ? <Paper
            id={menuId}
            role="menu"
            elevation={12}
            sx={{ width: 270, maxWidth: "calc(100vw - 24px)", p: 0.75, border: 1, borderColor: "divider", borderRadius: 2.5, bgcolor: "background.paper" }}
          >
            <MenuList disablePadding aria-label="Runtime settings">
              {sections.flatMap((item, index) => [
                ...(index === 1 ? [<Divider key="runtime-divider" sx={{ my: 0.5 }} />] : []),
                <MenuItem
                  key={item.id}
                  disabled={item.options.length === 0 || item.locked}
                  selected={section === item.id}
                  onClick={() => setSection(item.id)}
                  sx={{ minHeight: 48, borderRadius: 1.5, px: 1.25, gap: 1 }}
                >
                  <Typography sx={{ flex: 1 }}>{item.label}</Typography>
                  <Typography color="text.secondary" noWrap sx={{ maxWidth: 125 }}>{item.value}</Typography>
                  {!item.locked ? <ChevronRightIcon fontSize="small" sx={{ color: "text.secondary" }} /> : null}
                </MenuItem>,
              ])}
            </MenuList>
          </Paper> : null}
          {active ? <Paper
            elevation={12}
            sx={{ width: 310, maxWidth: "calc(100vw - 24px)", maxHeight: "min(55vh, 470px)", overflow: "hidden", border: 1, borderColor: "divider", borderRadius: 2.5, bgcolor: "background.paper" }}
          >
            <Box sx={{ px: 2, pt: 1.5, pb: 0.75 }}>
              <Typography color="text.secondary">{active.label}</Typography>
            </Box>
            <MenuList aria-label={`${active.label} options`} sx={{ maxHeight: "min(48vh, 410px)", overflowY: "auto", px: 0.75, pb: 0.75 }}>
              {compact ? <MenuItem onClick={() => setSection(null)} sx={{ borderRadius: 1.5 }}>Back</MenuItem> : null}
              {active.options.flatMap((option, index) => {
                const current = active.id === "engine" ? engine : active.id === "model" ? model : effort;
                const showGroup = option.group && option.group !== active.options[index - 1]?.group;
                return [
                  ...(showGroup ? [
                    <ListSubheader key={`group-${option.group}`} sx={{ bgcolor: "background.paper", lineHeight: "34px", fontWeight: 800 }}>
                      {option.group}
                    </ListSubheader>,
                  ] : []),
                  <MenuItem
                    key={option.id || "default"}
                    disabled={option.disabled}
                    selected={option.id === current}
                    onClick={() => select(option.id)}
                    sx={{ minHeight: option.detail ? 54 : 46, borderRadius: 1.5, gap: 1, alignItems: "flex-start" }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography>{option.label}</Typography>
                      {option.detail ? <Typography variant="caption" color="text.secondary">{option.detail}</Typography> : null}
                    </Box>
                    {option.id === current ? <CheckIcon fontSize="small" sx={{ mt: 0.25 }} /> : null}
                  </MenuItem>,
                ];
              })}
            </MenuList>
          </Paper> : null}
        </Stack>
      </ClickAwayListener>
    </Popper>
  </>;
}
