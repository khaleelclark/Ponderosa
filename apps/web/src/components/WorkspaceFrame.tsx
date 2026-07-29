import {
  Box,
  Stack,
  Tab,
  Tabs,
} from "@mui/material";
import {
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { IconTitle } from "./IconTitle";

type WorkspaceTabItem<T extends string> = { value: T; label: string; icon?: ReactElement };

export interface TabbedWorkspaceFrameProps<T extends string> {
  icon: ReactElement;
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
  const [visualValue, setVisualValue] = useState<T | false>(value);
  useEffect(() => setVisualValue(value), [value]);
  const select = (next: T) => {
    // Keep the selection responsive without demoting the content switch.
    // Live output can continuously preempt a transition and leave the selected
    // tab showing stale content, so the owning workspace update stays urgent.
    setVisualValue(next);
    onChange(next);
  };
  return <Box sx={{ borderBottom: 1, borderColor: "divider", minWidth: 0 }}>
    <Tabs
      aria-label={label}
      value={visualValue}
      onChange={(_, next: T) => select(next)}
      variant="scrollable"
      scrollButtons="auto"
      allowScrollButtonsMobile
      sx={{
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
        minHeight: 48,
        "& .MuiTabs-scrollButtons": {
          width: { xs: 28, sm: 40 },
        },
      }}
    >
      {items.map((item) => <Tab
        key={item.value}
        value={item.value}
        icon={item.icon}
        iconPosition="start"
        label={item.label}
        sx={{
          minHeight: 48,
          minWidth: { xs: 88, sm: 112 },
          px: { xs: 1.25, sm: 2 },
        }}
      />)}
    </Tabs>
  </Box>;
}

/**
 * The owning identity-and-navigation chrome for Home, Create, Project, Chat and
 * Agent workplaces. Keeping both rows together prevents padded or duplicated
 * local tab bars from drifting away from the identity header.
 */
export function TabbedWorkspaceFrame<T extends string>({
  icon,
  title,
  context,
  meta,
  status,
  actions,
  tabs,
}: TabbedWorkspaceFrameProps<T>): JSX.Element {
  return <Box className="mobile-chat-chrome mobile-chat-header" sx={{ minWidth: 0, bgcolor: "background.default" }}>
    <Box sx={{ px: { xs: 1.5, sm: 2, md: 2.5 }, py: { xs: 1, sm: 1.25 } }}>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        flexWrap={{ xs: "wrap", sm: "nowrap" }}
        sx={{ alignItems: { xs: "flex-start", sm: "center" }, minWidth: 0 }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <IconTitle icon={icon} title={title} component="h1" />
          {context ? <Box sx={{ mt: 0.15, minWidth: 0 }}>{context}</Box> : null}
          {meta ? <Box sx={{ mt: 0.15, minWidth: 0 }}>{meta}</Box> : null}
        </Box>
        {status || actions ? <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{
            alignItems: "center",
            justifyContent: "flex-end",
            flexWrap: "nowrap",
            flexShrink: 0,
          }}
        >{status}{actions}</Stack> : null}
      </Stack>
    </Box>
    <WorkspaceTabBar {...tabs} />
  </Box>;
}
