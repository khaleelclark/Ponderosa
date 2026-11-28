export function restoreOverlayFocus(previous: HTMLElement | undefined, fallback: string | readonly string[] = '[aria-label="Open Workspace Navigation"], nav[aria-label="Workspace Sections"] [aria-label="Open All Chats"]'): void {
  window.requestAnimationFrame(() => {
    if (
      previous?.isConnected &&
      previous.getClientRects().length > 0 &&
      !previous.closest('[aria-hidden="true"]')
    ) {
      previous.focus();
      return;
    }
    for (const selector of typeof fallback === "string" ? [fallback] : fallback) {
      const target = [...document.querySelectorAll<HTMLElement>(selector)].find(candidate => (
        candidate.getClientRects().length > 0 &&
        !candidate.closest('[aria-hidden="true"]')
      ));
      if (target) {
        target.focus();
        return;
      }
    }
  });
}
