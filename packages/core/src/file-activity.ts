/** Count changed lines in an engine-provided unified diff, excluding file headers. */
export function unifiedDiffLineTotals(
  diff: string | undefined,
): { additions: number; deletions: number } | undefined {
  if (!diff) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return additions || deletions ? { additions, deletions } : undefined;
}
