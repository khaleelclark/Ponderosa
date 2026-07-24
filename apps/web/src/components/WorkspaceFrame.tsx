import { Box, Stack, Tab, Tabs, Typography } from "@mui/material";
import type { ReactElement, ReactNode } from "react";

export type WorkspaceTabItem<T extends string> = { value: T; label: string; icon?: ReactElement };

export interface TabbedWorkspaceFrameProps<T extends string> {
  title: string;
  context?: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  tabs: {
    value: T | false;
    items: readonly WorkspaceTabItem<T>[];
    onChange(value: T): void;
    label: string;
  };
}

function WorkspaceTabBar<T extends string>({ value, items, onChange, label }: {
  value: T | false;
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

/**
 * The owning identity-and-navigation chrome for Home, Create, Project, Chat and
 * Agent workplaces. Keeping both rows together prevents padded or duplicated
 * local tab bars from drifting away from the identity header.
 */
export function TabbedWorkspaceFrame<T extends string>({
  title,
  context,
  meta,
  status,
  actions,
  tabs,
}: TabbedWorkspaceFrameProps<T>): JSX.Element {
  return <Box className="mobile-chat-chrome mobile-chat-header" sx={{ minWidth: 0, bgcolor: "background.default" }}>
    <Box sx={{ px: { xs: 1.5, sm: 2, md: 2.5 }, py: { xs: 1, sm: 1.25 } }}>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", minWidth: 0 }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="h6" component="h1" fontWeight={800} noWrap>{title}</Typography>
          {context ? <Box sx={{ mt: 0.15, minWidth: 0 }}>{context}</Box> : null}
          {meta ? <Box sx={{ mt: 0.15, minWidth: 0 }}>{meta}</Box> : null}
        </Box>
        {status || actions ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", justifyContent: "flex-end" }}>{status}{actions}</Stack> : null}
      </Stack>
    </Box>
    <WorkspaceTabBar {...tabs} />
  </Box>;
}
