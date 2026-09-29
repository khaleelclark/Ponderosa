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

/** Keep rejected Project-relative links inert instead of letting the browser
 * resolve them against the Ponderosa application's current URL. */
export function renderableWorkspaceMarkdownHref(
  projectId: string | undefined,
  currentPath: string | undefined,
  href: string | undefined,
  scope?: { agentId?: string; conversationId?: string; returnTo?: string },
): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("#") || /^(?:https?:\/\/|mailto:|tel:)/iu.test(href)) return href;
  if (href.startsWith("/")) {
    if (href.startsWith("//")) return undefined;
    try {
      const pathname = decodeURIComponent(href.split(/[?#]/u, 1)[0] ?? "");
      if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").includes("..")) return undefined;
      return href;
    } catch { return undefined; }
  }
  const resolved = projectId && currentPath ? workspaceMarkdownFileHref(projectId, currentPath, href) : undefined;
  if (!resolved || !scope) return resolved;
  const url = new URL(resolved, "http://ponderosa.invalid");
  if (scope.agentId) url.searchParams.set("agentId", scope.agentId);
  if (scope.conversationId) url.searchParams.set("conversationId", scope.conversationId);
  if (scope.returnTo) url.searchParams.set("returnTo", scope.returnTo);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function workspaceMarkdownMediaHref(projectId: string | undefined, currentPath: string | undefined, src: string | undefined, scope?: { agentId?: string; conversationId?: string }): string | undefined {
  if (!src) return undefined;
  if (/^https?:\/\//iu.test(src)) return src;
  if (!projectId || !currentPath) return undefined;
  const href = workspaceMarkdownFileHref(projectId, currentPath, src);
  if (!href) return undefined;
  const filePath = new URL(href, "http://ponderosa.invalid").searchParams.get("path");
  if (!filePath || !/\.(?:png|jpe?g|webp)$/iu.test(filePath)) return undefined;
  const query = new URLSearchParams({ path: filePath });
  if (scope?.agentId) query.set("agentId", scope.agentId);
  if (scope?.conversationId) query.set("conversationId", scope.conversationId);
  return `/api/projects/${encodeURIComponent(projectId)}/workspace-files/preview?${query}`;
}
