import type {
  EngineDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { ContextualCreateDialog } from "./CreateWorkspace";

/**
 * First-run Project creation shares the canonical Project form and adaptive
 * dialog with every other entry point. This wrapper only preserves the
 * onboarding completion callback used by App.
 */
export function ProjectCreationDialog({
  open,
  onboarding = false,
  engines,
  preferences,
  onClose,
  onCreated,
}: {
  open: boolean;
  onboarding?: boolean;
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  onClose(): void;
  onCreated(projectId: string, onboarding: boolean): void;
}): JSX.Element {
  return (
    <ContextualCreateDialog
      request={open ? { resource: "project" } : undefined}
      projects={[]}
      engines={engines}
      preferences={preferences}
      onClose={onClose}
      onNavigate={route => {
        if (route.kind !== "project") return;
        onCreated(route.projectId, onboarding);
      }}
    />
  );
}
