import type { ArtifactDto } from "@ponderosa/core";
import { presentedFileIdentity } from "../projectPathPresentation";

export type ProjectFileCategory =
  | "all"
  | "code"
  | "documents"
  | "data"
  | "images"
  | "archives"
  | "other";

export const PROJECT_FILE_CATEGORIES: Array<{
  value: ProjectFileCategory;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "code", label: "Code" },
  { value: "documents", label: "Documents" },
  { value: "data", label: "Data & Config" },
  { value: "images", label: "Images" },
  { value: "archives", label: "Archives" },
  { value: "other", label: "Other" },
];

const FILE_CATEGORY_EXTENSIONS: Record<
  Exclude<ProjectFileCategory, "all" | "other">,
  ReadonlySet<string>
> = {
  code: new Set([
    "c", "cc", "cpp", "css", "go", "h", "hpp", "html", "java", "js", "jsx",
    "kt", "php", "py", "rb", "rs", "scss", "sh", "swift", "ts", "tsx", "vue",
  ]),
  documents: new Set([
    "doc", "docx", "md", "mdx", "pdf", "ppt", "pptx", "rtf", "txt", "xls",
    "xlsx",
  ]),
  data: new Set([
    "csv", "graphql", "ini", "json", "jsonl", "sql", "toml", "tsv", "xml",
    "yaml", "yml",
  ]),
  images: new Set(["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"]),
  archives: new Set(["7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip"]),
};

function extensionForArtifact(artifact: ArtifactDto): string {
  const artifactPath = artifact.sourcePath ?? artifact.path;
  const name = artifactPath.split(/[\\/]/u).at(-1) ?? artifactPath;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name.slice(dot + 1).toLocaleLowerCase()
    : "";
}

export function projectFileCategory(
  artifact: ArtifactDto,
): Exclude<ProjectFileCategory, "all"> {
  const extension = extensionForArtifact(artifact);
  for (const [category, extensions] of Object.entries(
    FILE_CATEGORY_EXTENSIONS,
  ) as Array<
    [Exclude<ProjectFileCategory, "all" | "other">, ReadonlySet<string>]
  >) {
    if (extensions.has(extension)) return category;
  }
  return "other";
}

export function matchesProjectFileCategories(
  artifact: ArtifactDto,
  selected: readonly Exclude<ProjectFileCategory, "all">[],
): boolean {
  return (
    selected.length === 0 || selected.includes(projectFileCategory(artifact))
  );
}

export const projectOutputKinds = new Set<ArtifactDto["kind"]>([
  "diff",
  "test_report",
  "pr_summary",
  "document",
  "screenshot",
  "generated_file",
]);

export function projectArtifactDisplayPath(
  artifact: Pick<ArtifactDto, "path" | "sourcePath">,
  projectRoot: string,
): string {
  return presentedFileIdentity(projectRoot, artifact.sourcePath ?? artifact.path);
}

export function projectArtifactGroup(
  kind: ArtifactDto["kind"],
): "Modified & Created Files" | "Results" | undefined {
  if (["diff", "document", "screenshot", "generated_file"].includes(kind))
    return "Modified & Created Files";
  if (["test_report", "pr_summary"].includes(kind)) return "Results";
  return undefined;
}
