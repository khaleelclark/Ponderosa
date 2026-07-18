/** Count changed lines in an engine-provided unified diff, excluding file headers. */
export function unifiedDiffLineTotals(
  diff: string | undefined,
): { additions: number; deletions: number } | undefined {
  if (!diff) return undefined;
  const lines = diff.split(/\r?\n/u);
  const hasUnifiedHunk = lines.some((line) => line.startsWith("@@"));
  if (!hasUnifiedHunk) {
    const contentLines = lines.filter((line) => line.length > 0);
    // Some providers return the current file body in their `diff` field. A
    // Markdown list would otherwise look like hundreds of deletions. Keep the
    // compact single-line patch form supported, but decline to invent totals
    // when ordinary file content is mixed in.
    if (contentLines.some((line) => !line.startsWith("+") && !line.startsWith("-") && line !== "\\ No newline at end of file")) {
      return undefined;
    }
  }
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return additions || deletions ? { additions, deletions } : undefined;
}
