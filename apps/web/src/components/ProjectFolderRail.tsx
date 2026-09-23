import { Box, ButtonBase, Menu, MenuItem, Stack, Tooltip } from "@mui/material";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import { useRef, useState, type DragEvent } from "react";
import type { ProjectDto, ProjectFolderDto } from "@ponderosa/core";
import type { UnreadNotificationProjection } from "../workspaceNavigation";
import { ProjectRailButton } from "./ProjectNavigation";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { TextInputDialog } from "./ConfirmationDialogs";

/** Folder operations affect presentation preferences only, never Projects. */
export function ProjectFolderRail({ projects, folders, onChange, currentProjectId, activeProjectId, unread, running, onOpen, onReorder, onRename, onSettings, onDelete }: {
  projects: ProjectDto[]; folders: ProjectFolderDto[]; onChange(folders: ProjectFolderDto[]): void;
  currentProjectId?: string; activeProjectId?: string;
  unread: ReadonlyMap<string, UnreadNotificationProjection>; running?: ReadonlyMap<string, number>;
  onOpen(project: ProjectDto): void; onReorder(source: string, target: string, position: "before" | "after"): void;
  onRename(project: ProjectDto): void; onSettings(project: ProjectDto): void; onDelete(project: ProjectDto): void;
}) {
  const [dragged, setDragged] = useState<string>();
  const [target, setTarget] = useState<{ id: string; mode: "group" | "before" | "after" }>();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; project?: ProjectDto; folder?: ProjectFolderDto }>();
  const [renaming, setRenaming] = useState<ProjectFolderDto>();
  const suppressClick = useRef(false);
  const folderFor = (id: string) => folders.find(folder => folder.projectIds.includes(id));
  // Keep an empty source in the intent snapshot. The writer removes it only after
  // rebasing membership; omitting a folder instead means explicit Ungroup.
  const remove = (id: string) => folders.map(folder => ({ ...folder, projectIds: folder.projectIds.filter(member => member !== id) }));
  const move = (id: string, folderId?: string) => onChange(remove(id).map(folder => folder.id === folderId ? { ...folder, projectIds: [...folder.projectIds, id] } : folder));
  const group = (source: string, destination: string) => {
    if (source === destination) return;
    const folder = folderFor(destination);
    if (folder) {
      if (folderFor(source)?.id !== folder.id) move(source, folder.id);
    } else onChange([...remove(source), { id: crypto.randomUUID(), name: "Project folder", projectIds: [destination, source], expanded: true }]);
  };
  const finish = () => { setDragged(undefined); setTarget(undefined); setTimeout(() => { suppressClick.current = false; }, 0); };
  const zone = (event: DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    return ratio < .25 ? "before" : ratio > .75 ? "after" : "group";
  };
  const action = (callback: () => void) => { setMenu(undefined); callback(); };
  const renderProject = (project: ProjectDto) => <Box key={project.id} sx={{ position: "relative", borderRadius: 2, outline: target?.id === project.id && target.mode === "group" ? "2px solid" : "none", outlineColor: "info.main" }}>
    <ProjectRailButton project={project} current={project.id === currentProjectId} expanded={project.id === activeProjectId}
      unread={unread.get(project.id)} runningCount={running?.get(project.id)} dragging={dragged === project.id}
      activityUnknown={Boolean(running && !running.has(project.id))}
      dropPosition={target?.id === project.id && target.mode !== "group" ? target.mode : undefined}
      onContextMenu={event => { event.preventDefault(); setMenu({ anchor: event.currentTarget, project }); }}
      onClick={() => { if (!suppressClick.current) onOpen(project); }}
      onDragStart={event => { suppressClick.current = true; setDragged(project.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", project.id); }}
      onDragEnd={finish}
      onDragOver={event => { if (dragged && dragged !== project.id) { event.preventDefault(); setTarget({ id: project.id, mode: zone(event) }); } }}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation();
        if (dragged && dragged !== project.id) {
          const mode = zone(event);
          if (mode === "group") group(dragged, project.id);
          else {
            const destination = folderFor(project.id);
            if (destination) {
              const next = remove(dragged).map(folder => {
                if (folder.id !== destination.id) return folder;
                const members = [...folder.projectIds];
                members.splice(members.indexOf(project.id) + (mode === "after" ? 1 : 0), 0, dragged);
                return { ...folder, projectIds: members };
              });
              onChange(next);
            } else if (folderFor(dragged)) onChange(remove(dragged));
            if (!destination) onReorder(dragged, project.id, mode);
          }
        }
        finish();
      }} />
    <ButtonBase aria-label={`Project actions for ${project.label}`} onClick={event => setMenu({ anchor: event.currentTarget, project })}
      sx={{ display: { xs: "flex", sm: "none" }, position: "absolute", right: -7, top: -5, width: 24, height: 24, borderRadius: "50%", bgcolor: "background.paper" }}><MoreHorizIcon sx={{ fontSize: 16 }} /></ButtonBase>
  </Box>;
  const seen = new Set<string>();
  return <>
    {projects.map(project => {
      const folder = folderFor(project.id);
      if (!folder) return renderProject(project);
      if (seen.has(folder.id)) return null;
      seen.add(folder.id);
      const members = folder.projectIds.flatMap(id => { const p = projects.find(item => item.id === id); return p ? [p] : []; });
      const active = members.some(p => (running?.get(p.id) ?? 0) > 0);
      const unknown = Boolean(running && members.some(p => !running.has(p.id)));
      const notices = members.reduce((sum, p) => sum + (unread.get(p.id)?.totalCount ?? 0), 0);
      return <Stack key={folder.id} spacing={.8} sx={{ alignItems: "center", bgcolor: "action.hover", borderRadius: 2, py: .6, width: 56, flexShrink: 0 }}>
        <Tooltip title={`${folder.name}: ${members.map(p => p.label).join(", ")}`} placement="right">
          <ButtonBase aria-label={`Folder ${folder.name}`} aria-expanded={folder.expanded}
            onClick={() => onChange(folders.map(f => f.id === folder.id ? { ...f, expanded: !f.expanded } : f))}
            onContextMenu={event => { event.preventDefault(); setMenu({ anchor: event.currentTarget, folder }); }}
            onKeyDown={event => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault(); setMenu({ anchor: event.currentTarget, folder });
              }
            }}
            onDragOver={event => { if (dragged) { event.preventDefault(); setTarget({ id: folder.id, mode: "group" }); } }}
            onDrop={event => { event.preventDefault(); if (dragged && folderFor(dragged)?.id !== folder.id) move(dragged, folder.id); finish(); }}
            sx={{ position: "relative", width: 48, height: 48, borderRadius: 2, color: "info.main", outline: target?.id === folder.id ? "2px solid" : "none" }}>
            {folder.expanded ? <FolderOutlinedIcon /> : <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, 18px)", gap: .3 }}>
              {members.slice(0, 4).map(p => <Box key={p.id} sx={{ width: 18, height: 18, borderRadius: "50%", bgcolor: "action.selected", color: "text.primary", fontSize: 8 }}>{p.label.slice(0, 2).toUpperCase()}</Box>)}
            </Box>}
            {!folder.expanded && active ? <Box sx={{ position: "absolute", right: 1, bottom: 1, display: "flex" }}><AgentStatusIndicator status="running" /></Box> : null}
            {!folder.expanded && !active && unknown ? <Box component="span" role="img" aria-label="Activity not yet available" sx={{ position: "absolute", right: 1, bottom: 1, fontSize: 10 }}>?</Box> : null}
            {!folder.expanded && notices > 0 ? <Box component="span" aria-label={`${notices} unread`} sx={{ position: "absolute", right: 0, top: 0, borderRadius: "50%", bgcolor: "error.main", color: "white", px: .4, fontSize: 10 }}>{notices > 99 ? "99+" : notices}</Box> : null}
          </ButtonBase>
        </Tooltip>
        <ButtonBase aria-label={`Folder actions for ${folder.name}`} onClick={event => setMenu({ anchor: event.currentTarget, folder })} sx={{ display: { xs: "flex", sm: "none" }, minHeight: 24 }}><MoreHorizIcon fontSize="small" /></ButtonBase>
        {folder.expanded ? members.map(renderProject) : null}
      </Stack>;
    })}
    {dragged && folderFor(dragged) ? <ButtonBase onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); move(dragged); finish(); }} sx={{ p: 1, border: "1px dashed", fontSize: 10 }}>Move out of folder</ButtonBase> : null}
    <Menu open={Boolean(menu)} anchorEl={menu?.anchor} onClose={() => setMenu(undefined)}>
      {menu?.project ? [
        <MenuItem key="rename" onClick={() => action(() => onRename(menu.project!))}>Rename Project</MenuItem>,
        <MenuItem key="settings" onClick={() => action(() => onSettings(menu.project!))}>Project Settings</MenuItem>,
        <MenuItem key="delete" onClick={() => action(() => onDelete(menu.project!))}>Delete Project</MenuItem>,
        ...(folderFor(menu.project.id) ? [<MenuItem key="remove" onClick={() => action(() => move(menu.project!.id))}>Remove from Folder</MenuItem>] : []),
        ...folders.filter(f => !f.projectIds.includes(menu.project!.id)).map(f => <MenuItem key={f.id} onClick={() => action(() => move(menu.project!.id, f.id))}>Move to {f.name}</MenuItem>),
        <MenuItem key="create" onClick={() => action(() => {
          const folder = { id: crypto.randomUUID(), name: "Project folder", projectIds: [menu.project!.id], expanded: true };
          onChange([...remove(menu.project!.id), folder]); setRenaming(folder);
        })}>Create Folder</MenuItem>,
      ] : null}
      {menu?.folder ? [
        <MenuItem key="rename" onClick={() => action(() => setRenaming(menu.folder))}>Rename Folder</MenuItem>,
        <MenuItem key="ungroup" onClick={() => action(() => onChange(folders.filter(f => f.id !== menu.folder!.id)))}>Ungroup Projects</MenuItem>,
      ] : null}
    </Menu>
    <TextInputDialog open={Boolean(renaming)} title="Rename Folder" label="Folder name" confirmLabel="Rename" initialValue={renaming?.name ?? ""} onCancel={() => setRenaming(undefined)} onConfirm={name => {
      if (name.trim()) onChange(folders.map(f => f.id === renaming?.id ? { ...f, name: name.trim().slice(0, 100) } : f));
      setRenaming(undefined);
    }} />
  </>;
}
