import {createClientId} from '../clientId';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, List, ListItemButton, ListItemText, Menu, MenuItem, Paper, Popper, Stack, TextField, Typography, useMediaQuery } from "@mui/material";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import type { ChatFolderDto, ConversationDto, ProjectSort, WorkspaceConversationDirectoryItemDto } from "@ponderosa/core";
import { TextInputDialog } from "./ConfirmationDialogs";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { starColor } from "./WorkspaceSidebar.helpers";
import { sortChatFolderMembers, sortChatFolders } from "../resourcePreferences";
import { SidebarNotificationBadge } from "./SidebarNotificationBadge";
import type { UnreadNotificationProjection } from "../workspaceNavigation";
import { readBrowserStorage, writeBrowserStorage } from "../browserStorage";

type Item = WorkspaceConversationDirectoryItemDto;
const dragType = "application/x-ponderosa-chat";
const starredExpansionKey = (id: string) => `ponderosa.chat-folders.starred-expanded.v1.${id}`;
const initialStarredExpansion = (folder: ChatFolderDto): boolean => {
  const saved = readBrowserStorage("localStorage", starredExpansionKey(folder.id));
  return saved === "true" ? true : saved === "false" ? false : folder.expanded;
};

/** Folders only store conversation IDs; all chat actions retain their original scope. */
export function ChatFolders({ items, openItems = [], folders, sort, starredIds, filtering, folderUnread, notificationState, renderRow, onChange, onRename, onDelete, onReorder, children }: {
  items: Item[]; folders: ChatFolderDto[]; sort: ProjectSort; starredIds: ReadonlySet<string>; filtering: boolean;
  openItems?: Item[];
  folderUnread?: Record<string, UnreadNotificationProjection>;
  notificationState?: "loading" | "unavailable";
  renderRow(item: Item): ReactNode;
  onChange(folders: ChatFolderDto[], customOrder?: boolean): void;
  onRename(conversation: ConversationDto): void; onDelete(conversation: ConversationDto): void;
  onReorder(source: string, target: string, position: "before" | "after", folders?: ChatFolderDto[]): void;
  children(rows: { starredRows: ReactNode; allRows: ReactNode; openRows: ReactNode }): ReactNode;
}) {
  // All Chats retains its existing preference; Starred is a separate display
  // location, seeded once from the legacy value, never linked after that.
  const [starredExpanded, setStarredExpanded] = useState(() => new Map(folders.filter(folder => folder.starred).map(folder => [folder.id, initialStarredExpansion(folder)])));
  useEffect(() => {
    const starredFolders = folders.filter(folder => folder.starred);
    for (const folder of starredFolders) {
      const saved = readBrowserStorage("localStorage", starredExpansionKey(folder.id));
      if (saved !== "true" && saved !== "false") {
        writeBrowserStorage("localStorage", starredExpansionKey(folder.id), String(starredExpanded.get(folder.id) ?? folder.expanded));
      }
    }
    setStarredExpanded(previous => {
      const missing = starredFolders.filter(folder => !previous.has(folder.id));
      return missing.length ? new Map([...previous, ...missing.map(folder => [folder.id, initialStarredExpansion(folder)] as const)]) : previous;
    });
  }, [folders, starredExpanded]);
  const [dragged, setDragged] = useState<string>();
  const [draggedFolder, setDraggedFolder] = useState<string>();
  const [target, setTarget] = useState<{ id: string; zone: "group" | "before" | "after" }>();
  const [folderTarget, setFolderTarget] = useState<{ id: string; position: "before" | "after" }>();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; item?: Item; folder?: ChatFolderDto }>();
  const [renaming, setRenaming] = useState<ChatFolderDto>();
  const [moving, setMoving] = useState<Item>();
  const [folderSearch, setFolderSearch] = useState("");
  const desktopHover = useMediaQuery("(min-width: 600px) and (hover: hover) and (pointer: fine)");
  const [moveAnchor, setMoveAnchor] = useState<HTMLElement>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const stopTimer = () => { clearTimeout(hoverTimer.current); };
  const closePicker = () => { stopTimer(); setMoving(undefined); setMoveAnchor(undefined); };
  const closeMenu = () => { closePicker(); setMenu(undefined); };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const openPicker = (anchor: HTMLElement, focus = false) => {
    stopTimer(); setFolderSearch(""); setMoving(menu?.item);
    if (desktopHover) {
      setMoveAnchor(anchor);
      if (focus) requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#move-folder-search")?.focus());
    } else setMenu(undefined);
  };
  const leavePicker = () => { stopTimer(); hoverTimer.current = setTimeout(closePicker, 250); };
  const folderFor = (id: string) => folders.find(folder => folder.conversationIds.includes(id));
  const destinations = folders.filter(folder => folder.conversationIds.length
    && folder.id !== (moving ? folderFor(moving.conversation.id)?.id : undefined)
    && folder.name.toLocaleLowerCase().includes(folderSearch.trim().toLocaleLowerCase()));
  // Keep empty sources until the preferences writer rebases. Only Ungroup omits a folder.
  const remove = (id: string) => folders.map(folder => ({ ...folder, conversationIds: folder.conversationIds.filter(member => member !== id) }));
  const move = (id: string, destination?: string) => {
    if (folderFor(id)?.id === destination) return;
    onChange(remove(id).map(folder => folder.id === destination ? { ...folder, conversationIds: [...folder.conversationIds, id] } : folder));
  };
  const group = (source: string, destination: string) => {
    if (source === destination) return;
    const existing = folderFor(destination);
    if (existing) move(source, existing.id);
    else onChange([...remove(source), { id: createClientId(), name: "New folder", expanded: true, conversationIds: [destination, source] }]);
  };
  const toggleFolderStar = (id: string) =>
    onChange(folders.map(folder => folder.id === id ? { ...folder, starred: !folder.starred } : folder));
  const zone = (event: DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    return ratio < .25 ? "before" : ratio > .75 ? "after" : "group";
  };
  const endDrag = () => { setDragged(undefined); setTarget(undefined); setDraggedFolder(undefined); setFolderTarget(undefined); };
  const reorderFolder = (source: string, targetId: string, position: "before" | "after") => {
    if (source === targetId) return;
    const displayed = sortChatFolders(folders, items, sort);
    const next = displayed.filter(folder => folder.id !== source);
    const sourceFolder = displayed.find(folder => folder.id === source);
    const targetIndex = next.findIndex(folder => folder.id === targetId);
    if (!sourceFolder || targetIndex < 0) return;
    next.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceFolder);
    onChange(next, true);
  };
  const action = (run: () => void) => { closeMenu(); run(); };
  const row = (item: Item) => {
    const id = item.conversation.id;
    return <Box key={id} data-chat-folder-row={id} draggable
      onDragStart={event => { setDragged(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(dragType, id); }}
      onDragEnd={endDrag}
      onDragOver={event => { if (dragged && dragged !== id) { event.preventDefault(); setTarget({ id, zone: zone(event) }); } }}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation();
        if (dragged && dragged !== id) {
          const position = zone(event);
          if (position === "group") group(dragged, id);
          else {
            const destination = folderFor(id);
            if (destination) onChange(remove(dragged).map(folder => {
              if (folder.id !== destination.id) return folder;
              const visible = sortChatFolderMembers(folder, items, sort).map(item => item.conversation.id);
              const visibleIds = new Set(visible);
              const members = sort === "custom" ? [...folder.conversationIds] : [...visible, ...folder.conversationIds.filter(member => !visibleIds.has(member))];
              members.splice(members.indexOf(id) + (position === "after" ? 1 : 0), 0, dragged);
              return { ...folder, conversationIds: members };
            }), true);
            else onReorder(dragged, id, position, folderFor(dragged) ? remove(dragged) : undefined);
          }
        }
        endDrag();
      }}
      onContextMenu={event => { event.preventDefault(); setMenu({ anchor: event.currentTarget, item }); }}
      onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); setMenu({ anchor: event.currentTarget, item }); } }}
      sx={{ position: "relative", minWidth: 0, borderRadius: 1, opacity: dragged === id ? .5 : 1,
        outline: target?.id === id && target.zone === "group" ? "2px solid" : "none", outlineColor: "info.main",
        "&::after": target?.id === id && target.zone !== "group" ? { content: '""', position: "absolute", left: 0, right: 0,
          [target.zone === "before" ? "top" : "bottom"]: 0, height: 2, bgcolor: "primary.main", pointerEvents: "none" } : undefined,
        display: "flex", alignItems: "center", "& > .chat-row-content": { flex: 1, minWidth: 0 } }}>
      <Box className="chat-row-content">{renderRow(item)}</Box>
    </Box>;
  };
  const grouped = new Set(folders.flatMap(folder => folder.conversationIds));
  const ungrouped = items.filter(item => !grouped.has(item.conversation.id));
  const starred = (item: Item) => starredIds.has(`conversation:${item.conversation.id}`);
  const byId = new Map(items.map(item => [item.conversation.id, item]));
  const visibleFolders = sortChatFolders(folders.filter(folder => folder.conversationIds.length &&
    (!filtering || folder.conversationIds.some(id => byId.has(id)))), items, sort);
  const folderRow = (folder: ChatFolderDto, section: "starred" | "all") => {
    const members = sortChatFolderMembers(folder, items, sort);
    const savedExpanded = section === "starred" ? starredExpanded.get(folder.id) ?? initialStarredExpansion(folder) : folder.expanded;
    const expanded = filtering || savedExpanded;
    const active = members.some(item => (item.runningAgentCount ?? 0) > 0);
    const unread = folderUnread?.[folder.id];
    return <Box key={`${section}:${folder.id}`} data-chat-folder={folder.id} data-folder-section={section} sx={{ minWidth: 0, mt: .5, mb: 1 }}>
      <Stack direction="row" draggable
        onDragStart={event => { setDraggedFolder(folder.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-ponderosa-chat-folder", folder.id); }}
        onDragEnd={endDrag}
        onDragOver={event => {
          if (draggedFolder && draggedFolder !== folder.id) {
            event.preventDefault();
            setFolderTarget({ id: folder.id, position: event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2 ? "before" : "after" });
          } else if (dragged) { event.preventDefault(); setTarget({ id: folder.id, zone: "group" }); }
        }}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation();
          if (draggedFolder && draggedFolder !== folder.id) reorderFolder(draggedFolder, folder.id, event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2 ? "before" : "after");
          else if (dragged) move(dragged, folder.id);
          endDrag();
        }}
        onContextMenu={event => { event.preventDefault(); setMenu({ anchor: event.currentTarget, folder }); }}
        sx={{ borderRadius: 1, outline: target?.id === folder.id ? "2px solid" : "none", outlineColor: "info.main",
          ...(folderTarget?.id === folder.id ? { borderTop: folderTarget.position === "before" ? 2 : 0, borderBottom: folderTarget.position === "after" ? 2 : 0, borderColor: "primary.main" } : {}),
          "@media (hover: hover) and (pointer: fine)": { "& .sidebar-secondary": { opacity: 0 }, "&:hover .sidebar-secondary, &:focus-within .sidebar-secondary": { opacity: 1 } } }}>
        <ListItemButton aria-label={`Folder ${folder.name}`} aria-expanded={expanded}
          aria-description={unread ? `${unread.importantCount} important unread; ${unread.ordinaryCount} ordinary unread` :
            notificationState ? `Folder notifications ${notificationState}` : undefined}
          onClick={() => {
            if (section === "starred") {
              const next = !savedExpanded;
              setStarredExpanded(previous => new Map(previous).set(folder.id, next));
              writeBrowserStorage("localStorage", starredExpansionKey(folder.id), String(next));
            } else onChange(folders.map(value => value.id === folder.id ? { ...value, expanded: !folder.expanded } : value));
          }}
          onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); setMenu({ anchor: event.currentTarget, folder }); } }}
          sx={{ px: .5, py: 0, minWidth: 0, minHeight: { xs: 44, sm: 34 }, gap: .75 }}>
          {expanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
          <FolderOutlinedIcon fontSize="small" sx={{ color: "info.main" }} />
          <ListItemText primary={folder.name} primaryTypographyProps={{ noWrap: true, fontSize: 12.5, fontWeight: 750, letterSpacing: ".015em" }} sx={{ minWidth: 0 }} />
          {active ? <AgentStatusIndicator status="running" /> : null}
          {!active && !filtering && members.length < folder.conversationIds.length ? <Typography component="span" role="img" aria-label="Activity not yet available" variant="caption">?</Typography> : null}
          {unread ? <SidebarNotificationBadge unread={unread} /> : notificationState ?
            <Typography component="span" role="img" aria-label={notificationState === "loading" ? "Folder notifications loading" : "Folder notifications unavailable"} variant="caption">…</Typography> : null}
          <Typography variant="caption" color="text.secondary">{folder.conversationIds.length}</Typography>
        </ListItemButton>
        <IconButton className={folder.starred ? undefined : "sidebar-secondary"} size="small"
          aria-label={`${folder.starred ? "Unstar" : "Star"} folder ${folder.name}`}
          onClick={() => toggleFolderStar(folder.id)}
          sx={{ width: { xs: 44, sm: 32 }, minWidth: { xs: 44, sm: 32 }, height: { xs: 44, sm: 32 }, minHeight: { xs: 44, sm: 32 }, flexShrink: 0 }}>
          {folder.starred ? <StarRoundedIcon fontSize="small" sx={{ color: starColor }} /> : <StarBorderRoundedIcon fontSize="small" />}
        </IconButton>
      </Stack>
      {expanded ? <Box sx={{ pl: 1.5, borderLeft: 1, borderColor: "divider", ml: 1.5 }}>
        {members.map(row)}
        {!filtering && members.length < folder.conversationIds.length ? <Typography sx={{ p: 1 }} variant="caption" color="text.secondary">More chats in this folder may appear as you load the list.</Typography> : null}
      </Box> : null}
    </Box>;
  };
  const folderRows = visibleFolders.map(folder => folderRow(folder, "all"));
  const pickerContent = <>
    <TextField id="move-folder-search" autoFocus={!moveAnchor} fullWidth size="small" label="Search folders" value={folderSearch} onChange={event => setFolderSearch(event.target.value)} sx={{ mt: .5 }} />
    <List sx={{ mt: 1, maxHeight: "min(45dvh, 320px)", overflowY: "auto", overflowX: "hidden" }}>
      {destinations.map(folder => <ListItemButton key={folder.id} onClick={() => { if (moving) move(moving.conversation.id, folder.id); closeMenu(); }} sx={{ minHeight: 44, gap: 1 }}>
        <FolderOutlinedIcon fontSize="small" /><ListItemText primary={folder.name} primaryTypographyProps={{ sx: { overflowWrap: "anywhere" } }} />
      </ListItemButton>)}
      {!destinations.length ? <Typography color="text.secondary" sx={{ p: 1 }}>{folderSearch.trim() ? "No matching folders." : "No other folders available."}</Typography> : null}
    </List>
  </>;
  return <>
    {children({ openRows: openItems.map(row), starredRows: [...visibleFolders.filter(folder => folder.starred).map(folder => folderRow(folder, "starred")), ...items.filter(starred).map(row)], allRows: <>{folderRows}{ungrouped.filter(item => !starred(item)).map(row)}</> })}
    <Menu open={Boolean(menu)} anchorEl={menu?.anchor} onClose={closeMenu} disableEnforceFocus={Boolean(moveAnchor)}>
      {menu?.item ? [
        <MenuItem key="rename" onClick={() => action(() => onRename(menu.item!.conversation))}>Rename</MenuItem>,
        <MenuItem key="create" onClick={() => action(() => onChange([...remove(menu.item!.conversation.id), { id: createClientId(), name: "New folder", expanded: true, conversationIds: [menu.item!.conversation.id] }]))}>Create Folder</MenuItem>,
        <MenuItem key="move" aria-haspopup="dialog" aria-expanded={Boolean(moving)}
          onMouseEnter={event => { if (!desktopHover) return; stopTimer(); const anchor = event.currentTarget; hoverTimer.current = setTimeout(() => openPicker(anchor), 180); }}
          onMouseLeave={() => { if (desktopHover) leavePicker(); }}
          onKeyDown={event => { if (event.key === "ArrowRight") { event.preventDefault(); openPicker(event.currentTarget, true); } }}
          onClick={event => openPicker(event.currentTarget, true)}>Move To<Box sx={{ flex: 1, minWidth: 24 }} /><KeyboardArrowRightIcon fontSize="small" /></MenuItem>,
        ...(folderFor(menu.item.conversation.id) ? [<MenuItem key="remove" onClick={() => action(() => move(menu.item!.conversation.id))}>Remove from Folder</MenuItem>] : []),
        <MenuItem key="delete" sx={{ color: "error.main" }} onClick={() => action(() => onDelete(menu.item!.conversation))}>Delete</MenuItem>,
      ] : menu?.folder ? [
        <MenuItem key="rename" onClick={() => action(() => setRenaming(menu.folder))}>Rename Folder</MenuItem>,
        <MenuItem key="ungroup" onClick={() => action(() => onChange(folders.filter(folder => folder.id !== menu.folder!.id)))}>Ungroup Chats</MenuItem>,
      ] : null}
    </Menu>
    <Popper open={Boolean(moving && moveAnchor && menu)} anchorEl={moveAnchor} placement="right-start" modifiers={[{ name: "offset", options: { offset: [0, 2] } }, { name: "flip", options: { fallbackPlacements: ["left-start"] } }]} sx={{ zIndex: theme => theme.zIndex.modal + 1 }}>
      <Paper role="dialog" aria-label="Move To" elevation={8} onMouseEnter={stopTimer} onMouseLeave={leavePicker}
        onKeyDown={event => { if (event.key === "Escape" || (event.key === "ArrowLeft" && !(event.target instanceof HTMLInputElement))) { event.preventDefault(); const anchor = moveAnchor; closePicker(); anchor?.focus(); } }}
        sx={{ p: 1.5, width: 280, maxWidth: "calc(100vw - 32px)" }}>
        {pickerContent}<Button size="small" onClick={closeMenu}>Cancel</Button>
      </Paper>
    </Popper>
    <Dialog open={Boolean(moving && !moveAnchor)} onClose={closePicker} fullWidth maxWidth="xs" aria-labelledby="move-chat-title">
      <DialogTitle id="move-chat-title">Move To</DialogTitle>
      <DialogContent sx={{ overflow: "hidden" }}>
        {pickerContent}
      </DialogContent>
      <DialogActions><Button onClick={closePicker}>Cancel</Button></DialogActions>
    </Dialog>
    <TextInputDialog open={Boolean(renaming)} title="Rename Folder" label="Folder name" initialValue={renaming?.name ?? ""} confirmLabel="Rename"
      onCancel={() => setRenaming(undefined)} onConfirm={name => { if (renaming) onChange(folders.map(folder => folder.id === renaming.id ? { ...folder, name: name.trim().slice(0, 100) || folder.name } : folder)); setRenaming(undefined); }} />
  </>;
}
