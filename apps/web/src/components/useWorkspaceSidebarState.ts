import type { ConversationDto } from "@ponderosa/core";
import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  routeInitialSidebarSection,
  routeSynchronizedSidebarSection,
  type RouteSidebarSection,
} from "../routeRegistry";
import type { Route } from "../routing";
import { clampWorkspaceSidebarWidth } from "../workspaceSidebarState";
import type { ResourceContextMenuState } from "./ResourceContextMenu";

export function useWorkspaceSidebarNavigation(route: Route) {
  const [sidebarSection, setSidebarSection] =
    useState<RouteSidebarSection>(() => routeInitialSidebarSection(route));
  const [filter, setFilter] = useState("");
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
    // Directory workplaces are destinations, not sidebar-section commands.
    // Keep the operator's current panel, filter, and scroll state when one opens.
    const section = routeSynchronizedSidebarSection(route);
    if (!section) return;
    setSidebarSection(section);
    setFilter("");
  }, [route.kind]);

  return {
    sidebarSection,
    setSidebarSection,
    filter,
    setFilter,
    draggedResource,
    setDraggedResource,
    menu,
    setMenu,
    openResourceMenu,
  };
}

export function useWorkspaceSidebarResize(
  width: number,
  onWidthChange?: (width: number) => void,
) {
  const [resizing, setResizing] = useState(false);
  const resizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onWidthChange) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    setResizing(true);
    const move = (next: PointerEvent) =>
      onWidthChange(
        clampWorkspaceSidebarWidth(startWidth + next.clientX - startX),
      );
    const stop = () => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return { resizing, resizeStart };
}
