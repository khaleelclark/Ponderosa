import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "../src/components/chat/ChatMessages";
import { Composer } from "../src/components/chat/Composer";

const globalCss = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const projectShell = readFileSync(new URL("../src/components/ProjectShell.tsx", import.meta.url), "utf8");
const copyMessageButton = readFileSync(new URL("../src/components/CopyMessageButton.tsx", import.meta.url), "utf8");
const workspaceSidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.tsx", import.meta.url), "utf8");

describe("horizontal overflow containment", () => {
  it("constrains the app root and every responsive project shell to the viewport width", () => {
    expect(globalCss).toMatch(/#root\s*\{[^}]*overflow:\s*hidden;/s);
    expect(globalCss).toMatch(/html,\s*body,\s*#root\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(app).toMatch(
      /data-testid="ponderosa-app"[\s\S]*?display:\s*"grid",\s*gridTemplateColumns:\s*"minmax\(0, 1fr\)"/,
    );

    const constrainedShell = 'width: "100%", maxWidth: "100%", minHeight: 0, minWidth: 0, overflow: "hidden"';
    expect(projectShell.split(constrainedShell)).toHaveLength(3);
  });

  it("retains local horizontal scrolling for wide code, tables, and task output", () => {
    const html = renderToStaticMarkup(createElement(
      ChatMarkdown,
      null,
      "```text\nvery wide command output\n```\n\n| A | B |\n| - | - |\n| one | two |",
    ));
    expect(html).toContain("overflow-x:auto");
    expect(html).toContain("<table>");
  });

  it("keeps hidden announcements, mobile controls, and long project lists inside their surfaces", () => {
    expect(copyMessageButton).toContain('width: "1px", height: "1px"');
    const composer = renderToStaticMarkup(createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Composer, { disabled: false, running: false, onSend: () => undefined }),
    ));
    expect(composer).toContain("max-width:100%");
    expect(workspaceSidebar).toContain('width: drawer ? "min(100vw, 390px)" : collapsed ? SIDEBAR_RAIL_WIDTH : width');
    expect(app).toContain('width: "min(100vw, 390px)", maxWidth: "100vw"');
    expect(workspaceSidebar).toContain('minHeight: 0, overflowY: "auto"');
  });

  it("reserves scrollbar space so hover and keyboard focus never shift navigation", () => {
    expect(globalCss).toMatch(/\.ponderosa-scroll\s*\{[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-gutter:\s*stable;/s);
    expect(globalCss).toMatch(/\.ponderosa-scroll::\-webkit-scrollbar\s*\{[^}]*width:\s*8px;[^}]*height:\s*8px;/s);
    expect(globalCss).not.toMatch(/\.ponderosa-scroll:hover[^}]*scrollbar-width:\s*thin/s);
    expect(globalCss).not.toMatch(
      /\.ponderosa-scroll:hover,\s*\.ponderosa-scroll:focus-within\s*\{[^}]*(?:width|height|padding|margin):/s,
    );
    expect(workspaceSidebar).toContain('data-testid="workspace-navigation-scroll"');
    // One shared global resource panel plus the protected Wiki and Project Chats panels.
    expect(workspaceSidebar.match(/data-testid="workspace-navigation-scroll"/g)).toHaveLength(3);
    expect(workspaceSidebar).not.toMatch(/aria-label="Agent preview"[^]*overflowY/);
  });
});
