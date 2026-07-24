import { Box, Stack, Tab, Tabs, Typography } from "@mui/material";
import type { ReactNode } from "react";

export type WorkspaceTabItem<T extends string> = { value: T; label: string; icon?: ReactNode };

/** The Agent-detail header is the common identity frame for primary workplaces. */
export function WorkspaceHeader({ title, context, meta, status, actions }: {
  title: string;
  context?: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return <Box className="mobile-chat-chrome mobile-chat-header" sx={{ px: { xs: 1, sm: 1.5, md: 2 }, py: { xs: 0.75, sm: 1.25 }, borderBottom: 1, borderColor: "divider" }}>
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", minWidth: 0 }}>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="h6" fontWeight={800} noWrap>{title}</Typography>
        {context ? <Box sx={{ mt: 0.15 }}>{context}</Box> : null}
        {meta ? <Box sx={{ mt: 0.15 }}>{meta}</Box> : null}
      </Box>
      {status || actions ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", justifyContent: "flex-end" }}>{status}{actions}</Stack> : null}
    </Stack>
  </Box>;
}

/** Shared local navigation chrome for primary Ponderosa workplaces. */
export function WorkspaceTabBar<T extends string>({ value, items, onChange, label }: {
  value: T;
  items: readonly WorkspaceTabItem<T>[];
  onChange(value: T): void;
  label: string;
}): JSX.Element {
  return <Tabs aria-label={label} value={value} onChange={(_, next: T) => onChange(next)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile sx={{
    width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden", borderBottom: 1, borderColor: "divider", minHeight: 48,
  }}>
    {items.map((item) => <Tab key={item.value} value={item.value} icon={item.icon} iconPosition="start" label={item.label} sx={{ minHeight: 48, minWidth: { xs: "auto", sm: 112 }, px: { xs: 1.25, sm: 2 } }} />)}
  </Tabs>;
}

export function WorkspaceContent({ children }: { children: ReactNode }): JSX.Element {
  return <Box sx={{ minHeight: 0, minWidth: 0, overflow: "auto" }}>{children}</Box>;
}
