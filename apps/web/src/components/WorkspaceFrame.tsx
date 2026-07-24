import { Box, Tab, Tabs } from "@mui/material";
import type { ReactNode } from "react";

export type WorkspaceTabItem<T extends string> = { value: T; label: string; icon?: ReactNode };

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
