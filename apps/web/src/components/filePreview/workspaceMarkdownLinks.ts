import { routeToPath } from "../../routeRegistry.js";

/** Resolve a Markdown link against the file being viewed, not the browser URL. */
export function workspaceMarkdownFileHref(
  projectId: string,
  currentPath: string,
  href: string | undefined,
): string | undefined {
  if (!href || href.startsWith("/") || href.startsWith("#") || /^[a-z][a-z\d+.-]*:/iu.test(href)) return undefined;
  const [targetAndQuery, fragment] = href.split("#", 2);
  const target = targetAndQuery?.split("?", 1)[0];
  if (!target) return undefined;

  const parts = currentPath.split("/").slice(0, -1);
  try {
    for (const rawPart of target.split("/")) {
      const part = decodeURIComponent(rawPart);
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return undefined;
        parts.pop();
      } else {
        if (part.includes("/") || part.includes("\\") || part.includes("\0")) return undefined;
        parts.push(part);
      }
    }
  } catch {
    return undefined;
  }
  if (!parts.length) return undefined;
  return `${routeToPath({ kind: "workspaceFile", projectId, path: parts.join("/") })}${fragment === undefined ? "" : `#${fragment}`}`;
}
