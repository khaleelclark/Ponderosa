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
