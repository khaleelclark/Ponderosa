import CheckIcon from "@mui/icons-material/Check";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import {
  Alert,
  Box,
  ButtonBase,
  ClickAwayListener,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Stack,
  Typography,
} from "@mui/material";
import type { ProviderPermissionMode } from "@ponderosa/core";
import { useId, useState } from "react";

const options: Array<{
  id: ProviderPermissionMode;
  label: string;
  shortLabel: string;
  detail: string;
}> = [
  {
    id: "ask",
    label: "Ask for approval",
    shortLabel: "Ask",
    detail: "Pause for every provider confirmation.",
  },
  {
    id: "auto_confirmations",
    label: "Auto-approve confirmations",
    shortLabel: "Auto-approve",
    detail:
      "Allow empty yes/no provider confirmations for every Agent in this Chat. Forms and connection requests still pause.",
  },
];

export function ComposerProviderPermissions({
  mode,
  pending,
  error,
  onChange,
}: {
  mode: ProviderPermissionMode;
  pending?: boolean;
  error?: string;
  onChange(mode: ProviderPermissionMode): void;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const selected = options.find(option => option.id === mode) ?? options[0]!;
  const close = () => setAnchor(null);

  return <>
    <ButtonBase
      aria-label={`Provider permissions: ${selected.label}`}
      aria-haspopup="menu"
      aria-controls={anchor ? menuId : undefined}
      aria-expanded={Boolean(anchor)}
      disabled={pending}
      onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      sx={{
        minHeight: 40,
        px: 1,
        borderRadius: 1.25,
        color: mode === "auto_confirmations" ? "warning.main" : "text.secondary",
        "&:hover": { bgcolor: "action.hover" },
        "&:focus-visible": {
          outline: "2px solid",
          outlineColor: "primary.main",
          outlineOffset: 2,
        },
      }}
    >
      <Stack direction="row" spacing={0.6} sx={{ alignItems: "center" }}>
        <ShieldOutlinedIcon sx={{ fontSize: 18 }} />
        <Typography variant="body2" noWrap sx={{ fontWeight: 700 }}>
          {selected.shortLabel}
        </Typography>
        <KeyboardArrowDownIcon sx={{ fontSize: 20 }} />
      </Stack>
    </ButtonBase>
    <Popper
      open={Boolean(anchor)}
      anchorEl={anchor}
      placement="top-start"
      modifiers={[
        { name: "offset", options: { offset: [0, 8] } },
        { name: "preventOverflow", options: { padding: 12 } },
        { name: "flip", options: { fallbackPlacements: ["top-end", "bottom-start"] } },
      ]}
      sx={{ zIndex: 1500 }}
    >
      <ClickAwayListener onClickAway={close}>
        <Paper
          id={menuId}
          role="menu"
          elevation={12}
          sx={{
            width: 350,
            maxWidth: "calc(100vw - 24px)",
            p: 0.75,
            border: 1,
            borderColor: "divider",
            borderRadius: 2.5,
            bgcolor: "background.paper",
          }}
        >
          <Box sx={{ px: 1.25, pt: 0.75, pb: 0.5 }}>
            <Typography fontWeight={800}>Provider permissions</Typography>
            <Typography variant="caption" color="text.secondary">
              Applies to every Agent and subagent in this Chat.
            </Typography>
          </Box>
          <MenuList disablePadding aria-label="Provider permission settings">
            {options.map(option => (
              <MenuItem
                key={option.id}
                selected={option.id === mode}
                onClick={() => {
                  close();
                  if (option.id !== mode) onChange(option.id);
                }}
                sx={{
                  minHeight: 64,
                  borderRadius: 1.5,
                  px: 1.25,
                  py: 0.75,
                  gap: 1,
                  alignItems: "flex-start",
                  whiteSpace: "normal",
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography fontWeight={700}>{option.label}</Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", lineHeight: 1.35 }}
                  >
                    {option.detail}
                  </Typography>
                </Box>
                {option.id === mode ? <CheckIcon fontSize="small" sx={{ mt: 0.25 }} /> : null}
              </MenuItem>
            ))}
          </MenuList>
          {error ? <Alert severity="error" sx={{ mt: 0.75 }}>{error}</Alert> : null}
        </Paper>
      </ClickAwayListener>
    </Popper>
  </>;
}
