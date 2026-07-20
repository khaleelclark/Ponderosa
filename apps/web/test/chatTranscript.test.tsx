import type { ImageAttachmentDto } from "@ponderosa/core";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMarkdownTranscript, downloadMarkdownTranscript, transcriptFileName } from "../src/chatTranscript";
import { CHAT_EXPORT_ACTION_LABELS, ChatOverflowMenu } from "../src/components/ChatOverflowMenu";

const attachment: ImageAttachmentDto = {
  id: "asset-1",
  agentId: "agent-1",
  name: "screen [final].png",
  mediaType: "image/png",
  size: 42,
  url: "/api/agents/agent-1/attachments/asset-1",
  downloadUrl: "/api/agents/agent-1/attachments/asset-1?download=1",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat transcript export", () => {
  it("formats clean human-facing Markdown with attachment references", () => {
    const markdown = buildMarkdownTranscript("Release chat", [
      { author: "You", text: "Please review this.", createdAt: "2026-07-16T10:00:00.000Z" },
      { author: "Agent One", text: "Review complete.", createdAt: "2026-07-16T10:01:00.000Z", attachments: [attachment] },
    ]);

    expect(markdown).toBe([
      "# Release chat",
      "",
      "## You · 2026-07-16T10:00:00.000Z",
      "",
      "Please review this.",
      "",
      "## Agent One · 2026-07-16T10:01:00.000Z",
      "",
      "Review complete.",
      "",
      "**Attachments**",
      "",
      "- [Attachment: screen \\[final\\].png](</api/agents/agent-1/attachments/asset-1?download=1>)",
      "",
    ].join("\n"));
    expect(markdown).not.toContain("command");
    expect(markdown).not.toContain("diff");
    expect(transcriptFileName("Release / Chat ✅")).toBe("release-chat-transcript.md");
  });

  it("exports attachment-only messages and ignores execution-shaped detail outside the chat projection", () => {
    const markdown = buildMarkdownTranscript("# Build", [{
      author: "Agent *One*",
      text: "",
      attachments: [attachment],
      command: "do-not-export",
      diff: "+do-not-export",
    } as Parameters<typeof buildMarkdownTranscript>[1][number] & { command: string; diff: string }]);

    expect(markdown).toContain("# \\# Build");
    expect(markdown).toContain("## Agent \\*One\\*");
    expect(markdown).toContain("Attachment: screen \\[final\\].png");
    expect(markdown).not.toContain("do-not-export");
  });

  it("downloads the exact Markdown produced for clipboard export", async () => {
    const markdown = buildMarkdownTranscript("Release chat", [
      { author: "You", text: "Please review this.", attachments: [attachment] },
    ]);
    const click = vi.fn();
    const remove = vi.fn();
    const anchor = { href: "", download: "", style: { display: "" }, click, remove };
    const appendChild = vi.fn();
    let downloadedBlob: Blob | undefined;
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      downloadedBlob = blob;
      return "blob:transcript";
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    downloadMarkdownTranscript(markdown, "release-chat.md");

    expect(await downloadedBlob?.text()).toBe(markdown);
    expect(anchor).toMatchObject({ href: "blob:transcript", download: "release-chat.md" });
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:transcript");
  });

  it("exposes matching Copy and Download menus with a chat transcript option", () => {
    const html = renderToStaticMarkup(<ChatOverflowMenu
      actions={[{ label: "Rename", onSelect: vi.fn() }]}
      copyActions={[{ label: "Full Agent", onSelect: vi.fn() }]}
      downloadActions={[{ label: "Full Agent", onSelect: vi.fn() }]}
      transcriptMarkdown="# Chat\n"
      transcriptFileName="chat.md"
    />);
    expect(html).toContain('aria-label="Chat Actions"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(CHAT_EXPORT_ACTION_LABELS).toEqual(["Copy", "Download", "Chat Transcript"]);
  });

  it("keeps setup and mutations in menus and replaces the subagent prompt card with lineage", () => {
    const agentDetail = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
    const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
    expect(agentDetail).toContain('label="Agent Chat Actions"');
    expect(agentDetail).toContain('detailsLabel="Run Settings"');
    expect(agentDetail).toContain('aria-label="Run settings" sx={{ px: 0.5, py: 0.25 }}');
    expect(agentDetail).toContain('label: "Start Fresh Provider Session",\n                icon: <RestartAltIcon');
    expect(agentDetail).toContain('label: "Assign Chats"');
    expect(agentDetail).toContain('icon: <ForumOutlinedIcon fontSize="small" />');
    expect(agentDetail).toContain('label: "Quick Copy into Project Chat", icon: <ContentCopyOutlinedIcon');
    expect(agentDetail).toContain('label: "Create Agent"');
    expect(agentDetail).toContain('label: "Full Agent"');
    expect(agentDetail).toContain('label: "Full Organization"');
    expect(agentDetail).not.toContain("Copy Agent context");
    expect(agentDetail).toContain('label: "Import Agent or Organization…"');
    expect(agentDetail).toContain('icon: <FileUploadOutlinedIcon fontSize="small" />');
    expect(agentDetail).toContain("Created by");
    expect(agentDetail).not.toContain("Original message");
    expect(conversation).toContain('label: "Create Agent"');
    expect(conversation).toContain('label: "Import Agent or Organization…"');
    expect(conversation).toContain('icon: <FileUploadOutlinedIcon fontSize="small" />');
    expect(conversation).toContain("ChatOverflowMenu");
    expect(conversation).not.toContain("Describe a request — starts a new agent");
  });
});
