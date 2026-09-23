import type { ArtifactDto } from "@ponderosa/core";
import { presentProjectPath } from "../../projectPathPresentation";

type PresentedArtifact = Pick<ArtifactDto, "kind" | "path" | "sourcePath" | "summary" | "legacyRecovery">;

/** Resolve the workspace path represented by an immutable file-change artifact. */
export function artifactSourcePath(
  artifact: Pick<ArtifactDto, "path" | "sourcePath" | "summary">,
): string {
  if (artifact.sourcePath) return artifact.sourcePath;
  const historicalSourcePath = artifact.summary
    ?.trim()
    .match(/^(?:create|edit|delete)\s+(.+)$/iu)?.[1]
    ?.trim();
  return historicalSourcePath || artifact.path;
}

export function artifactDisplayPath(
  artifact: Pick<ArtifactDto, "path" | "sourcePath" | "summary">,
  projectRoot?: string,
): string {
  return presentProjectPath(
    projectRoot ?? "",
    artifactSourcePath(artifact),
  ).displayPath;
}

/**
 * Artifact summaries are provider-authored and may contain host paths. Ordinary
 * UI therefore derives labels only from the artifact kind and a path that has
 * already passed through project-path presentation. Raw summaries remain
 * available to explicit technical/diagnostic surfaces.
 */
export function artifactDisplayLabel(
  artifact: PresentedArtifact,
  displayPath = artifactDisplayPath(artifact),
): string {
  if (artifact.legacyRecovery) return `Recovered legacy file · ${displayPath}`;
  const action = artifact.summary?.trim().match(/^(create|edit|delete)(?:\s|$)/iu)?.[1];
  const actionLabel = action
    ? action[0]!.toLocaleUpperCase() + action.slice(1).toLocaleLowerCase()
    : undefined;

  switch (artifact.kind) {
    case "diff":
      return `${actionLabel ?? "Change"} · ${displayPath}`;
    case "document":
    case "generated_file":
      return displayPath;
    case "screenshot":
      return "Browser screenshot";
    case "test_report":
      return "Test report";
    case "pr_summary":
      return "Pull request summary";
    case "log":
      return "Command output";
  }
}

/** Ordinary filtering must use only values already safe for presentation. */
export function artifactSearchText(
  artifact: PresentedArtifact,
  projectRoot?: string,
): string {
  const displayPath = artifactDisplayPath(artifact, projectRoot);
  return [artifactDisplayLabel(artifact, displayPath), displayPath, artifact.kind]
    .join(" ")
    .toLocaleLowerCase();
}
