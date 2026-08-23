import type { ConversationDto } from "@ponderosa/core";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  routeInitialSidebarSection,
  routeSynchronizedSidebarSection,
  type RouteSidebarSection,
} from "../routeRegistry";
import { routeProjectId, type Route } from "../routing";
import { clampWorkspaceSidebarWidth } from "../workspaceSidebarState";
import type { ResourceContextMenuState } from "./ResourceContextMenu";

export function useWorkspaceSidebarNavigation(route: Route) {
  const [sidebarSection, setSidebarSection] =
    useState<RouteSidebarSection>(() => routeInitialSidebarSection(route));
  const previousRoute = useRef(route);
  const [filter, setFilter] = useState("");
  const [projectSection, setProjectSection] = useState<ProjectSidebarSection>(
    () => projectSidebarSectionForRoute(route),
  );
  const [draggedResource, setDraggedResource] = useState<{
    kind: "home" | "chat" | "agent" | "trigger";
    id: string;
  }>();
  type SidebarMenuResource = { route: Route; conversation?: ConversationDto };
  const [menu, setMenu] =
    useState<ResourceContextMenuState<SidebarMenuResource>>();
  const openResourceMenu = (
    anchor: HTMLElement,
    route: Route,
    conversation?: ConversationDto,
  ) =>
    setMenu({
      anchor,
      resource: { route, ...(conversation ? { conversation } : {}) },
    });
  useEffect(() => {
    const previous = previousRoute.current;
    previousRoute.current = route;
    const previousProjectId = routeProjectId(previous);
    const projectId = routeProjectId(route);
    if (projectId) {
      const nextProjectSection = projectSidebarSectionForRoute(route);
      if (
        previousProjectId === projectId &&
        projectSidebarSectionForRoute(previous) !== nextProjectSection
      ) {
        setProjectSection(nextProjectSection);
        setFilter("");
      }
    }
    // Directory workplaces are destinations, not sidebar-section commands.
    // Keep the operator's current panel, filter, and scroll state when one opens.
    const section = routeSynchronizedSidebarSection(route);
    if (section) {
      setSidebarSection(section);
      if (routeSynchronizedSidebarSection(previous) !== section) {
        setFilter("");
      }
      return;
    }
    // Only the global Create flow owns the Create sidebar. Contextual creation
    // keeps the operator's existing sidebar while replacing the workspace.
    if (
      previous.kind === "create" &&
      previous.surface !== "workspace"
    ) {
      setSidebarSection(routeInitialSidebarSection(route));
      setFilter("");
    }
  }, [route]);

  return {
    sidebarSection,
    setSidebarSection,
    projectSection,
    setProjectSection,
    filter,
    setFilter,
    draggedResource,
    setDraggedResource,
    menu,
    setMenu,
    openResourceMenu,
  };
}

export type ProjectSidebarSection =
  | "overview"
  | "chats"
  | "agents"
  | "triggers";

function projectSidebarSectionForRoute(route: Route): ProjectSidebarSection {
  if (route.kind === "conversation") return "chats";
  if (route.kind === "agents" || route.kind === "review") return "agents";
  if (route.kind === "agent") {
    return route.view === "triggers" ? "triggers" : "agents";
  }
  if (route.kind === "project") {
    if (route.view === "agents") return "agents";
    if (route.view === "triggers") return "triggers";
  }
  return "overview";
}

export function useWorkspaceSidebarResize(
  width: number,
  onWidthChange?: (width: number) => void,
) {
  const [resizing, setResizing] = useState(false);
  // A drag attaches window listeners that only pointerup or pointercancel
  // removes. Unmounting mid-drag delivers neither, so they outlived the
  // sidebar and kept driving onWidthChange against a gone component. Hold the
  // detach so unmount can run it; it takes no state so it is safe there.
  const detachDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => {
    detachDrag.current?.();
    detachDrag.current = undefined;
  }, []);

  const resizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onWidthChange) return;
    event.preventDefault();
    detachDrag.current?.();
    const startX = event.clientX;
    const startWidth = width;
    setResizing(true);
    const move = (next: PointerEvent) =>
      onWidthChange(
        clampWorkspaceSidebarWidth(startWidth + next.clientX - startX),
      );
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      detachDrag.current = undefined;
    };
    const stop = () => {
      detach();
      setResizing(false);
    };
    detachDrag.current = detach;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return { resizing, resizeStart };
}
