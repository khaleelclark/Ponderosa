import {useEffect} from "react";
import type {WorkspacePreferencesDto} from "@ponderosa/core";

/** Shared persisted font preference for the two product shells. */
export function useWorkspaceFont(fontFamily:WorkspacePreferencesDto["fontFamily"]|undefined):void {
  useEffect(() => {
    if (!fontFamily) return;
    const families = {
      inter:
        'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      system:
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      sans: "Arial, Helvetica, sans-serif",
    } as const;
    document.documentElement.style.setProperty(
      "--ponderosa-font-family",
      families[fontFamily],
    );
  }, [fontFamily]);
}
