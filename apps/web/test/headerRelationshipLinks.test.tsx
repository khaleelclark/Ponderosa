// @vitest-environment node

import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  AgentHeaderRelationships,
  orderedAgentHeaderChats,
  ProjectRelationshipLink,
} from "../src/components/HeaderRelationshipLinks";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  return {
    ...actual,
    Menu: ({ children, open }: { children?: ReactNode; open: boolean }) => open ? <>{children}</> : null,
    MenuItem: ({ children, ...props }: { children?: ReactNode; onClick?(): void; "aria-label"?: string }) =>
      <button type="button" {...props}>{children}</button>,
  };
});

describe("workspace header relationships", () => {
  it("keeps a Project Chat name primary while exposing its Project as an accessible navigation target", () => {
    const openProject = vi.fn();
    const view = create(<>
      <h1>Design Review</h1>
      <ProjectRelationshipLink projectLabel="Ponderosa" onOpenProject={openProject} />
    </>);
    expect(view.root.findByType("h1").props.children).toBe("Design Review");
    const projectLink = view.root.findByProps({ "aria-label": "Open project Ponderosa" });
    act(() => projectLink.props.onClick());
    expect(openProject).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("orders full membership with the primary chat first", () => {
    expect(orderedAgentHeaderChats(
      ["chat-review", "chat-primary", "chat-ops"],
      [
        { id: "chat-ops", title: "Operations" },
        { id: "chat-review", title: "Design Review" },
        { id: "chat-primary", title: "Workspace UX" },
      ],
      "chat-primary",
    )).toEqual([
      { id: "chat-primary", title: "Workspace UX" },
      { id: "chat-review", title: "Design Review" },
      { id: "chat-ops", title: "Operations" },
    ]);
  });

  it("exposes Project and a one-chat direct navigation callback", () => {
    const openProject = vi.fn();
    const openChat = vi.fn();
    const view = create(<AgentHeaderRelationships
      projectLabel="Ponderosa"
      chats={[{ id: "chat-primary", title: "Workspace UX" }]}
      onOpenProject={openProject}
      onOpenChat={openChat}
    />);
    act(() => view.root.findAllByProps({ "aria-label": "Open project Ponderosa" })[0]!.props.onClick());
    act(() => view.root.findAllByProps({ "aria-label": "Open Project Chat Workspace UX" })[0]!.props.onClick());
    expect(openProject).toHaveBeenCalledOnce();
    expect(openChat).toHaveBeenCalledWith("chat-primary");
    view.unmount();
  });

  it("opens an anchored +N Chats list and routes each additional membership", () => {
    const openChat = vi.fn();
    const view = create(<AgentHeaderRelationships
      projectLabel="Ponderosa"
      chats={[
        { id: "chat-primary", title: "Workspace UX" },
        { id: "chat-review", title: "Design Review" },
        { id: "chat-ops", title: "Operations" },
      ]}
      onOpenProject={vi.fn()}
      onOpenChat={openChat}
    />);
    act(() => view.root.findByProps({ "aria-label": "Open Project Chat Workspace UX" }).props.onClick());
    expect(openChat).toHaveBeenCalledWith("chat-primary");
    openChat.mockClear();
    const trigger = view.root.findByProps({ "aria-label": "Show 2 more Project Chats" });
    expect(trigger.props["aria-haspopup"]).toBe("menu");
    act(() => trigger.props.onClick({ currentTarget: {} as HTMLElement }));
    expect(view.root.findByProps({ "aria-label": "Show 2 more Project Chats" }).props["aria-controls"]).toBe("agent-header-chat-menu");
    const review = view.root.findByProps({ "aria-label": "Open Project Chat Design Review" });
    act(() => review.props.onClick());
    expect(openChat).toHaveBeenCalledWith("chat-review");
    view.unmount();
  });

  it("uses the compact mobile Project · N Chats label", () => {
    const view = create(<AgentHeaderRelationships
      projectLabel="Ponderosa"
      chats={[
        { id: "chat-primary", title: "Workspace UX" },
        { id: "chat-review", title: "Design Review" },
        { id: "chat-ops", title: "Operations" },
      ]}
      onOpenProject={vi.fn()}
      onOpenChat={vi.fn()}
    />);
    const compactProject = view.root.findAllByType("button")
      .find((node) => node.props["aria-label"] === "Open project Ponderosa" && node.props.children === "Project");
    const compactChats = view.root.findByProps({ "aria-label": "Show 3 Project Chats" });
    expect(compactProject?.props.children).toBe("Project");
    expect(compactChats.props.children.join("")).toBe("3 Chats");
    view.unmount();
  });
});
