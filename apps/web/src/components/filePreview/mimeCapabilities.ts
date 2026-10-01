import type { ArtifactKind } from "@ponderosa/core";

type PreviewCapability = "image" | "markdown" | "text" | "pdf" | "docx" | "diff" | "unsupported";

export interface MimeCapability {
  kind: PreviewCapability;
  label: string;
  inline: boolean;
}

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  md: "text/markdown",
  mdown: "text/markdown",
  mdx: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  diff: "text/x-diff",
  patch: "text/x-diff",
  json: "application/json",
  jsonl: "application/x-ndjson",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function normalizedMediaType(mediaType?: string, path?: string): string {
  const explicit = mediaType?.split(";", 1)[0]?.trim().toLocaleLowerCase();
  if (explicit && explicit !== "application/octet-stream") return explicit;
  const name = path?.split(/[\\/]/u).at(-1) ?? "";
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLocaleLowerCase() : undefined;
  return extension ? (EXTENSION_MEDIA_TYPES[extension] ?? explicit ?? "application/octet-stream") : explicit ?? "application/octet-stream";
}

export function previewCapability({
  mediaType,
  path,
  artifactKind,
  contentType,
}: {
  mediaType?: string;
  path?: string;
  artifactKind?: ArtifactKind;
  contentType?: "markdown" | "diff" | "text";
}): MimeCapability {
  const normalized = normalizedMediaType(mediaType, path);
  if (normalized === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return { kind: "docx", label: "Word document", inline: true };
  }
  if (contentType === "diff" || artifactKind === "diff" || normalized === "text/x-diff" || normalized === "text/x-patch") {
    return { kind: "diff", label: "Unified diff", inline: true };
  }
  if (contentType === "markdown" || normalized === "text/markdown" || normalized === "text/x-markdown") {
    return { kind: "markdown", label: "Markdown", inline: true };
  }
  if (normalized.startsWith("image/")) return { kind: "image", label: "Image", inline: true };
  if (normalized === "application/pdf") return { kind: "pdf", label: "PDF", inline: true };
  // HTML and SVG documents are never embedded as active documents. SVG is
  // safe only through the image path above, where the browser does not execute
  // it as a top-level page.
  if (normalized === "text/html" || normalized === "application/xhtml+xml") {
    return { kind: "unsupported", label: "HTML document", inline: false };
  }
  if (contentType === "text" || normalized.startsWith("text/") || [
    "application/json",
    "application/ld+json",
    "application/x-ndjson",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
  ].includes(normalized)) {
    return { kind: "text", label: "Text", inline: true };
  }
  return { kind: "unsupported", label: normalized === "application/octet-stream" ? "File" : normalized, inline: false };
}
