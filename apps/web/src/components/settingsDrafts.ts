export function synchronizePristineDraft(
  current: string,
  canonical: string,
  dirty: boolean,
): string {
  return dirty ? current : canonical;
}
