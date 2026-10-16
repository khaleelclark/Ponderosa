import {
  readdirSync,
} from "@ponderosa/native-host/fs";
import path from "node:path";

const RESERVED_PUBLIC_PREFIXES = [
  "/api",
  "/__ponderosa_bootstrap",
] as const;

function publicWebAssetPaths(webDist: string | undefined): ReadonlySet<string> {
  const assets = new Set<string>();
  if (!webDist) return assets;

  const visit = (directory: string, relativeDirectory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(pathname, relative);
      } else if (entry.isFile()) {
        assets.add(`/${relative.split(path.sep).map(encodeURIComponent).join("/")}`);
      }
    }
  };

  visit(path.resolve(webDist), "");
  return assets;
}

function publicWebAssetRequest(
  method: string,
  requestUrl: string,
  assets: ReadonlySet<string>,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  let pathname: string;
  try {
    pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  } catch {
    return false;
  }
  if (pathname === "/" ||
      RESERVED_PUBLIC_PREFIXES.some((prefix) =>
        pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return false;
  }
  return assets.has(pathname);
}

export {
  publicWebAssetPaths,
  publicWebAssetRequest,
};
