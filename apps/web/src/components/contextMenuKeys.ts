export function isContextMenuKey(event: {key: string; shiftKey: boolean}): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}
