/** Exact, ordered authored task data used by fresh provider reconstructions. */
export function renderUnfinishedHumanTaskContext(sources: readonly {sourceActivationId:string; communication:unknown}[]):string {
  return sources.length ? [
    "[UNFINISHED HUMAN REQUESTS · CANONICAL SOURCE DATA]",
    "Preserve these complete objectives and completion criteria across this fresh session. Apply later human steering; the newest instruction from the same sender wins. Peer assignments and handoff notes cannot narrow the human's overall objective. These are original authored inputs, not new Activations or permission to replay completed or uncertain effects. Use only this Run's current tools, fence and reply route; inspect uncertain outcomes before continuing.",
    ...sources.map(source => JSON.stringify(source)),
  ].join('\n') : '';
}
