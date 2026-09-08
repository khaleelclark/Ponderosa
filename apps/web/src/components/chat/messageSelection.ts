const INTERACTIVE_DESCENDANT = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
].join(",");

export function messageSelectionTargetIsInteractive(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!target || target === currentTarget) return false;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  return typeof closest === "function" && Boolean(closest.call(target, INTERACTIVE_DESCENDANT));
}

export function messageSelectionIntersectsCurrentTarget(
  currentTarget: EventTarget | null,
  selection = (currentTarget as Node | null)?.ownerDocument?.getSelection(),
): boolean {
  if (!currentTarget || !selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(currentTarget as Node)) return true;
    } catch { /* a detached or foreign-document selection does not own this message */ }
  }
  return false;
}
