/** Leave modified clicks and native tab/window behavior to the browser. */
export function isUnmodifiedPrimaryClick(event: {
  button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean;
  altKey: boolean; defaultPrevented: boolean;
}): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey
    && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
