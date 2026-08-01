import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAttachments } from "../src/components/chat/ChatAttachments";

describe("ChatAttachments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  it("renders multiple authorized files without probing transfer routes", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ChatAttachments attachments={[
      {
        id: "document-artifact",
        agentId: "agent-a",
        name: "review.pdf",
        mediaType: "application/pdf",
        size: 4096,
        previewUrl: "/preview/document-artifact",
        downloadUrl: "/download/document-artifact",
      },
      {
        id: "archive-artifact",
        agentId: "agent-a",
        name: "results.zip",
        mediaType: "application/zip",
        size: 8192,
        downloadUrl: "/download/archive-artifact",
      },
    ]} />);

    expect(screen.getByText("application/pdf · 4096 bytes")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Preview review.pdf" }).getAttribute("href"))
      .toBe("/preview/document-artifact");
    expect(screen.getByRole("link", { name: "Download review.pdf" }).getAttribute("href"))
      .toBe("/download/document-artifact");
    expect(screen.getByRole("link", { name: "Download results.zip" }).getAttribute("href"))
      .toBe("/download/archive-artifact");
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("retries an image whose URL changes after an earlier load failure", async () => {
    const view = render(<ChatAttachments attachments={[{
      id: "retry-image",
      agentId: "agent-a",
      name: "retry.png",
      mediaType: "image/png",
      size: 128,
      previewUrl: "/preview/old",
    }]} />);
    fireEvent.error(screen.getByRole("img", { name: "retry.png" }));
    expect(screen.getByRole("status").textContent).toContain("Artifact unavailable");

    view.rerender(<ChatAttachments attachments={[{
      id: "retry-image",
      agentId: "agent-a",
      name: "retry.png",
      mediaType: "image/png",
      size: 128,
      previewUrl: "/preview/new",
    }]} />);
    expect((await screen.findByRole("img", { name: "retry.png" })).getAttribute("src"))
      .toBe("/preview/new");
  });
});
