export function languageForPath(filePath: string): string {
  const extension = filePath.split(".").at(-1)?.toLocaleLowerCase();
  return ({
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    css: "css",
    html: "html",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "bash",
    yml: "yaml",
    yaml: "yaml",
  } as Record<string, string>)[extension ?? ""] ?? "text";
}
