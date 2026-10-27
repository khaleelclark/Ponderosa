import { defaultUrlTransform } from "react-markdown";
import { productApiPath } from "../../api/productScope.js";

export interface ChatProjectFileReference {
  projectId: string;
  artifactId: string;
  historicalFilename: string;
  currentFilename: string;
}

export function parseChatProjectFileHref(url: string | undefined): ChatProjectFileReference | undefined {
  if (!url?.startsWith("ponderosa://project-file/")) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ponderosa:" || parsed.hostname !== "project-file" || parsed.username || parsed.password || parsed.port || parsed.hash) return undefined;
    const rawSegments = parsed.pathname.slice(1).split("/");
    if (rawSegments.length !== 2 || rawSegments.some(segment => !segment)) return undefined;
    decodeURIComponent(parsed.search);
    const projectId = decodeURIComponent(rawSegments[0]!);
    const artifactId = decodeURIComponent(rawSegments[1]!);
    if (!projectId || !artifactId) return undefined;
    return {
      projectId,
      artifactId,
      historicalFilename: parsed.searchParams.get("historical") ?? "Project file",
      currentFilename: parsed.searchParams.get("current") ?? "",
    };
  } catch {
    return undefined;
  }
}

export function chatMarkdownUrlTransform(url: string, key: string, projectId?: string): string {
  // Match the server's bounded canonical reference grammar, without URL
  // normalization admitting credentials, encoded separators or extra parts.
  const artifact = /^ponderosa:\/\/artifact\/([A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?)$/u.exec(url);
  if (artifact && artifact[0] === url) {
    return key === "href" && projectId
      ? productApiPath(`/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact[1]!)}/download`)
      : "";
  }
  return url.startsWith("ponderosa://project-file/")
    ? (parseChatProjectFileHref(url) ? url : "")
    : defaultUrlTransform(url);
}

export const renderableChatLinkHref = (
  href: string | undefined,
): string | undefined => href || undefined;
