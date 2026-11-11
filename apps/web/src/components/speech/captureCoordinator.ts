/** One page-local audio/capture lease shared by dictation, recordings, audio playback and calls. */
interface Capture { release(): void; owner?: object }
let active: Capture | undefined;
export function abandonPageCapture(exceptOwner?: object): void {
  const owner = active;
  if (exceptOwner && owner?.owner === exceptOwner) return;
  active = undefined;
  owner?.release();
}
export const ownsPageCapture = (owner: object): boolean => active?.owner === owner;
export function claimPageCapture(abandon: () => void, owner?: object): () => void {
  abandonPageCapture();
  const capture = { release: abandon, owner };
  active = capture;
  return () => { if (active === capture) active = undefined; };
}
