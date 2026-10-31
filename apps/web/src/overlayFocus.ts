export function restoreOverlayFocus(previous: HTMLElement | undefined, fallbackSelector = '[aria-label="Open workspace navigation"], nav[aria-label="Workspace sections"] [aria-label="Open All Chats"]'): void {
  window.requestAnimationFrame(() => {
    if (
      previous?.isConnected &&
      previous.getClientRects().length > 0 &&
      !previous.closest('[aria-hidden="true"]')
    ) {
      previous.focus();
      return;
    }
    const stableNavigationTarget = [
      ...document.querySelectorAll<HTMLElement>(
        fallbackSelector,
      ),
    ].find(candidate => (
      candidate.getClientRects().length > 0 &&
      !candidate.closest('[aria-hidden="true"]')
    ));
    stableNavigationTarget?.focus();
  });
}
