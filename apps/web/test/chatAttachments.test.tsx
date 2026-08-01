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

  it("renders file metadata plus preview and download only after the serving routes confirm availability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    render(<ChatAttachments attachments={[{
      id: "document-artifact",
      agentId: "agent-a",
      name: "review.pdf",
      mediaType: "application/pdf",
      size: 4096,
      previewUrl: "/preview/document-artifact",
      downloadUrl: "/download/document-artifact",
    }]} />);

    expect(screen.getByRole("status").textContent).toContain("Checking artifact availability");
    expect((await screen.findByRole("link", { name: "Preview review.pdf" })).getAttribute("href"))
      .toBe("/preview/document-artifact");
    expect(screen.getByRole("link", { name: "Download review.pdf" }).getAttribute("href"))
      .toBe("/download/document-artifact");
  });

  it("turns a corrupt non-image response into a URL-free unavailable card", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<ChatAttachments attachments={[{
      id: "corrupt-artifact",
      agentId: "agent-a",
      name: "corrupt.pdf",
      mediaType: "application/pdf",
      size: 4096,
      previewUrl: "/preview/corrupt-artifact",
      downloadUrl: "/download/corrupt-artifact",
    }]} />);

    await screen.findByText("Artifact unavailable");
    expect(screen.getByRole("status").textContent).toContain("Artifact unavailable");
    expect(screen.queryByRole("link")).toBeNull();
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
