/** Copy text without breaking native selection/long-press behavior. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission policies commonly block Clipboard in installed PWAs. Fall
      // through to the selection-based browser command.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy is unavailable in this browser");
}

/**
 * Start an asynchronous text export without losing the transient user
 * activation required by Safari and other clipboard-restricted browsers.
 */
export async function copyDeferredText(
  text: Promise<string>,
): Promise<void> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      const item = new ClipboardItem({
        "text/plain": text.then(
          value => new Blob([value], { type: "text/plain" }),
        ),
      });
      await navigator.clipboard.write([item]);
      return;
    } catch {
      // Fall through for browsers without deferred ClipboardItem support.
    }
  }
  await copyText(await text);
}
