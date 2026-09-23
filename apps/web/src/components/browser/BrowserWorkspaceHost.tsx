import { Fragment, useEffect, useRef, useState } from "react";
import { Alert, Divider, IconButton, ListSubheader, Menu, MenuItem, Snackbar, Tooltip, useMediaQuery } from "@mui/material";
import ViewQuiltIcon from "@mui/icons-material/ViewQuilt";
import { ProjectBrowserDialog } from "../ProjectBrowserDialog";
import type { ProjectBrowserRequest } from "../ProjectBrowserContext";
import { browserDockIsAvailable } from "./browserWindowSizing";

type Panel = { key: string; projectId: string; agent?: { id: string; runId: string }; request?: ProjectBrowserRequest };
const keyFor = (projectId: string, agent?: Panel["agent"]) => `${projectId}:${agent?.id ?? "shared"}`;

/** Panels are views of existing chat/Run authorities, never new browser owners. */
export function BrowserWorkspaceHost({ projectId, agent, request, projects, onRequestHandled, onClose, onDockWidth }: {
  projectId: string;
  agent?: Panel["agent"];
  request?: ProjectBrowserRequest;
  projects: Array<{ id: string; label: string }>;
  onRequestHandled(requestId: number): void;
  onClose(): void;
  onDockWidth(width: number): void;
}) {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [docked, setDocked] = useState<string>();
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [limitNotice, setLimitNotice] = useState(false);
  const lastExternal = useRef<{ key: string; requestId?: number; agent?: Panel["agent"] }>();
  const mobile = useMediaQuery("(max-width: 899px)");
  const canDock = useMediaQuery("(min-width: 1400px)");
  const label = (panel: Panel) => `${projects.find(item => item.id === panel.projectId)?.label ?? "Chat"}${panel.agent ? " · Agent" : ""}`;
  const activate = (key: string) => setPanels(current => current.at(-1)?.key === key ? current : [...current.filter(item => item.key !== key), ...current.filter(item => item.key === key)]);
  const openPanel = (next: Panel) => {
    setPanels(current => {
      const found = current.find(item => item.key === next.key);
      if (!found && current.length >= 4) return current; // Bounded live viewers; tabs remain separately capped at 30.
      return [...current.filter(item => item.key !== next.key), { ...found, ...next }];
    });
  };
  useEffect(() => {
    const key = keyFor(projectId, agent);
    if (lastExternal.current?.key === key && lastExternal.current.agent === agent && (!request || lastExternal.current.requestId === request.requestId)) return;
    lastExternal.current = { key, requestId: request?.requestId, agent };
    if (panels.length >= 4 && !panels.some(panel => panel.key === key)) { setLimitNotice(true); return; }
    setPanels(current => {
      const found = current.find(item => item.key === key);
      const others = current.filter(item => item.key !== key);
      return [...others, { ...found, key, projectId, agent, request }];
    });
    setDocked(browserDockIsAvailable(window.innerWidth) ? key : undefined);
  }, [projectId, agent, request?.requestId]);
  useEffect(() => {
    if (!canDock) setDocked(undefined);
  }, [canDock]);
  useEffect(() => { onDockWidth(docked ? widths[docked] ?? 0 : 0); }, [docked, widths, onDockWidth]);
  useEffect(() => () => onDockWidth(0), [onDockWidth]);
  return <>
    {panels.map((panel, index) => <Fragment key={panel.key}>
      <ProjectBrowserDialog projectId={panel.projectId} agent={panel.agent} workspaceLabel={label(panel)} open={!mobile || index === panels.length - 1}
        request={panel.request}
        onRequestHandled={requestId => {
          setPanels(current => current.map(item => item.key === panel.key && item.request?.requestId === requestId ? { ...item, request: undefined } : item));
          onRequestHandled(requestId);
        }}
        onDockWidth={width => setWidths(current => current[panel.key] === width ? current : { ...current, [panel.key]: width })}
        windowOptions={{ docked: docked === panel.key, onDock: () => { if (browserDockIsAvailable(window.innerWidth)) setDocked(panel.key); }, onUndock: () => setDocked(current => current === panel.key ? undefined : current), onActivate: () => activate(panel.key), layer: index, offset: index, label: `Browser · ${label(panel)}` }}
        workspaceControls={<Tooltip title="Browser workspaces"><IconButton size="small" aria-label="Browser workspaces" onClick={event => setMenu(event.currentTarget)}><ViewQuiltIcon /></IconButton></Tooltip>}
        onClose={() => {
          setPanels(current => current.filter(item => item.key !== panel.key));
          if (docked === panel.key) setDocked(undefined);
          if (panels.length === 1) onClose();
        }} />
    </Fragment>)}
    <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)} disableRestoreFocus>
      <ListSubheader>Open workspaces</ListSubheader>
      {panels.map(panel => <MenuItem key={panel.key} selected={panels.at(-1)?.key === panel.key} onClick={() => { setMenu(null); activate(panel.key); }}>{label(panel)}</MenuItem>)}
      <Divider />
      <ListSubheader>{panels.length >= 4 ? "Close a panel to open another" : "Open another chat browser"}</ListSubheader>
      {projects.filter(project => !panels.some(panel => panel.key === keyFor(project.id))).map(project => <MenuItem key={project.id} disabled={panels.length >= 4} onClick={() => { setMenu(null); openPanel({ key: keyFor(project.id), projectId: project.id }); }}>{project.label}</MenuItem>)}
    </Menu>
    <Snackbar open={limitNotice} onClose={() => setLimitNotice(false)}><Alert severity="info" onClose={() => setLimitNotice(false)}>Four browser panels are already open. Close a panel before opening another; its browser and tabs will keep running.</Alert></Snackbar>
  </>;
}
