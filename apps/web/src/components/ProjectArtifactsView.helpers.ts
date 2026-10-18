import type { ArtifactDto } from "@ponderosa/core";
import { presentedFileIdentity } from "../projectPathPresentation";

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
