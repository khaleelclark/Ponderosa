import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatAttachments } from "../src/components/chat/ChatAttachments";

describe("ChatAttachments", () => {
  it("renders an authorized image inline with full preview and download actions", () => {
    render(<ChatAttachments attachments={[{
      id: "image-artifact",
      agentId: "agent-a",
      name: "latest.png",
      mediaType: "image/png",
      size: 128,
      previewUrl: "/preview/image-artifact",
      downloadUrl: "/download/image-artifact",
    }]} />);

    const image = screen.getByRole("img", { name: "latest.png" });
    expect(image.getAttribute("src")).toBe("/preview/image-artifact");
    fireEvent.click(screen.getByRole("button", { name: "Preview latest.png" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download latest.png" }).getAttribute("href"))
      .toBe("/download/image-artifact");
  });

  it("renders file metadata plus preview and download only when authorized URLs exist", () => {
    render(<ChatAttachments attachments={[{
      id: "document-artifact",
      agentId: "agent-a",
      name: "review.pdf",
      mediaType: "application/pdf",
      size: 4096,
      previewUrl: "/preview/document-artifact",
      downloadUrl: "/download/document-artifact",
    }]} />);

    expect(screen.getByText("application/pdf · 4096 bytes")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Preview review.pdf" }).getAttribute("href"))
      .toBe("/preview/document-artifact");
    expect(screen.getByRole("link", { name: "Download review.pdf" }).getAttribute("href"))
      .toBe("/download/document-artifact");
  });

  it("shows a stable unavailable state without exposing preview or download URLs", () => {
    render(<ChatAttachments attachments={[{
      id: "missing-artifact",
      agentId: "unavailable",
      name: "Artifact unavailable",
      mediaType: "application/octet-stream",
      size: 0,
      unavailable: true,
    }]} />);

    expect(screen.getByRole("status").textContent).toContain("Artifact unavailable");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
