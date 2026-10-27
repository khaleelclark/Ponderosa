/** One page-local recognition lease shared by ordinary dictation and calls. */
interface Capture { release(): void }
let active: Capture | undefined;
export function abandonPageCapture(): void {
  const owner = active;
  active = undefined;
  owner?.release();
}
export function claimPageCapture(abandon: () => void): () => void {
  abandonPageCapture();
  const owner = { release: abandon };
  active = owner;
  return () => { if (active === owner) active = undefined; };
}
