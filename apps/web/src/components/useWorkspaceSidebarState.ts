import type { ConversationDto } from "@ponderosa/core";
import { useEffect, useRef, useState } from "react";
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
  const previousRouteKind = useRef(route.kind);
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
    const previousKind = previousRouteKind.current;
    previousRouteKind.current = route.kind;
    // Directory workplaces are destinations, not sidebar-section commands.
    // Keep the operator's current panel, filter, and scroll state when one opens.
    const section = routeSynchronizedSidebarSection(route);
    if (section) {
      setSidebarSection(section);
      setFilter("");
      return;
    }
    // A Create workspace owns the Create sidebar until creation or cancellation
    // sends the active tab somewhere else. Clicking the rail + alone does not
    // change the route, so it must leave the chosen sidebar panel in place.
    if (previousKind === "create") {
      setSidebarSection(routeInitialSidebarSection(route));
      setFilter("");
    }
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
