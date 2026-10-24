import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import { Box, ButtonBase, Paper, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { CompactWorkspaceHeader } from "./WorkspaceFrame";
import { SemanticStatus, type SemanticStatusKind } from "./SemanticStatus";

export function HomeSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: JSX.Element;
  children: ReactNode;
}): JSX.Element {
  return (
    <Box component="section">
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: { xs: 0.75, sm: 1.25 }, minWidth: 0 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" component="h2" fontWeight={800} noWrap>{title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ "@container (max-width: 680px)": { display: "none" } }}>{description}</Typography>
        </Box>
        {action}
      </Stack>
      {children}
    </Box>
  );
}

export function HomeSummaryCard({
  label,
  value,
  compactLabel,
  compactValue,
  onClick,
}: {
  label: string;
  value: string | number;
  compactLabel?: string;
  compactValue?: string | number;
  onClick?(): void;
}): JSX.Element {
  const content = (
    <Stack spacing={0} sx={{ p: { xs: 1, sm: 1.5 }, minWidth: 0, textAlign: "left" }}>
      <Typography variant="h5" component="div" fontWeight={800} noWrap sx={{ fontSize: { xs: 19, sm: undefined } }}>
        {compactValue === undefined ? value : (
          <><Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>{compactValue}</Box><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>{value}</Box></>
        )}
      </Typography>
      <Typography variant="body2" color="text.secondary" noWrap sx={{ fontSize: { xs: 12, sm: undefined } }}>
        {compactLabel === undefined ? label : (
          <><Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>{compactLabel}</Box><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>{label}</Box></>
        )}
      </Typography>
    </Stack>
  );
  return (
    <Paper variant="outlined" sx={{ minWidth: 0, overflow: "hidden" }}>
      {onClick ? (
        <ButtonBase
          onClick={onClick}
          sx={{
            display: "block",
            width: "100%",
            transition: theme => theme.transitions.create("background-color", {
              duration: theme.transitions.duration.shortest,
            }),
            "&:hover": { bgcolor: "action.hover" },
            "&.Mui-focusVisible": { bgcolor: "action.selected" },
          }}
        >
          {content}
        </ButtonBase>
      ) : content}
    </Paper>
  );
}

export function HomeItemCard({
  icon,
  title,
  detail,
  status,
  statusLabel,
  statusAccessibleLabel,
  statusDetail,
  multilineDetail = false,
  statusBelow = false,
  onClick,
}: {
  icon: JSX.Element;
  title: string;
  detail: string;
  status?: SemanticStatusKind;
  statusLabel?: string;
  statusAccessibleLabel?: string;
  statusDetail?: string;
  multilineDetail?: boolean;
  statusBelow?: boolean;
  onClick(): void;
}): JSX.Element {
  const badge = status ? <Box sx={{ flexShrink: 0, ...(statusBelow ? { mt: .75, maxWidth: "100%", "& .MuiChip-root": { height: "auto", minHeight: 24, maxWidth: "100%" }, "& .MuiChip-label": { whiteSpace: "normal", overflowWrap: "anywhere", py: .25 } } : {}) }}>
    <SemanticStatus status={status} label={statusLabel} accessibleLabel={statusAccessibleLabel} detail={statusDetail} />
  </Box> : null;
  return (
    <Paper
      variant="outlined"
      sx={{ minWidth: 0, height: "100%", overflow: "hidden" }}
    >
      <ButtonBase
        onClick={onClick}
        sx={{
          width: "100%",
          minHeight: multilineDetail ? 78 : undefined,
          height: "100%",
          p: 1.35,
          gap: 1.25,
          justifyContent: "flex-start",
          textAlign: "left",
          overflow: "hidden",
          transition: theme => theme.transitions.create("background-color", {
            duration: theme.transitions.duration.shortest,
          }),
          "&:hover": { bgcolor: "action.hover" },
          "&.Mui-focusVisible": { bgcolor: "action.selected" },
        }}
      >
        <Box sx={{ width: 36, height: 36, borderRadius: 1.25, bgcolor: "action.selected", color: "text.secondary", display: "grid", placeItems: "center", flexShrink: 0 }}>
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography fontWeight={750} noWrap>{title}</Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap={!multilineDetail}
            sx={multilineDetail ? {
              display: "-webkit-box",
              minHeight: "2.7em",
              overflow: "hidden",
              overflowWrap: "anywhere",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              lineHeight: 1.35,
            } : { display: { xs: "block", md: "inline" }, maxWidth: "100%" }}
          >
            {detail}
          </Typography>
          {statusBelow ? badge : null}
        </Box>
        {statusBelow ? null : badge}
      </ButtonBase>
    </Paper>
  );
}

export const homeItemsGridSx = { display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, gap: 1 } as const;
export const homeSummaryGridSx = {
  display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: { xs: 1, sm: 1.25 },
  "@container (min-width: 760px)": { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" },
} as const;

export function HomeLayout({ context, loading, status, children, fill = false }: {
  context: string; loading: boolean; status: string; children: ReactNode; fill?: boolean;
}): JSX.Element {
  return <Box className="ponderosa-scroll" aria-busy={loading} sx={{ minHeight: 0, overflowY: "auto", ...(fill ? { height: "100%" } : {}) }}>
    <Box component="span" role="status" sx={{ position: "absolute", width: "1px", height: "1px", p: 0, m: "-1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>{status}</Box>
    <CompactWorkspaceHeader icon={<HomeOutlinedIcon />} title="Home" context={context} />
    <Box sx={{ p: { xs: 1.5, sm: 3, lg: 4 }, containerType: "inline-size" }}>
      <Stack spacing={{ xs: 2, sm: 3 }} sx={{ width: "100%", maxWidth: 1320, mx: "auto" }}>{children}</Stack>
    </Box>
  </Box>;
}

export function HomeFirstItem({ icon, title, description, children }: { icon: JSX.Element; title: string; description: string; children: ReactNode }): JSX.Element {
  return <Paper variant="outlined" sx={{ p: 3, textAlign: "center" }}>
    {icon}
    <Typography variant="h6" component="h2" fontWeight={800}>{title}</Typography>
    <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>{description}</Typography>
    {children}
  </Paper>;
}
