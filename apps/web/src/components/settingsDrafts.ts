export function synchronizePristineDraft(
  current: string,
  canonical: string,
  dirty: boolean,
): string {
  return dirty ? current : canonical;
}

export function draftChangedSinceSubmission(
  current: string,
  submitted: string,
): boolean {
  return current !== submitted;
}
