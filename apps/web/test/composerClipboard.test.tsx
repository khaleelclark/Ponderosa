import { describe, expect, it } from "vitest";
import { StrictMode } from "react";
import { create, unstable_batchedUpdates } from "react-test-renderer";
import { Composer, filesFromClipboard, selectComposerFiles } from "../src/components/panes";

const file = (name: string, type: string, size = 4) => {
  const value = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  Object.defineProperty(value, "size", { value: size });
  return value;
};
const clipboard = (files: File[]) => ({
  clipboardData: { items: files.map((value) => ({ kind: "file", getAsFile: () => value })) },
  preventDefault: () => undefined,
});
const pasteTarget = (view: ReturnType<typeof create>) => view.root.findAll((node) => typeof node.props.onPaste === "function")[0]!;

describe("composer clipboard attachments", () => {
  it("extracts only clipboard file items and preserves browser metadata", () => {
    const image = file("pasted-image.png", "image/png");
    const document = file("notes.pdf", "application/pdf");
    expect(filesFromClipboard([
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => image },
      { kind: "file", getAsFile: () => document },
    ])).toEqual([image, document]);
  });

  it("falls back to clipboardData.files when item extraction is unavailable", () => {
    const image = file("browser-fallback.png", "image/png");
    expect(filesFromClipboard([{ kind: "file", getAsFile: () => null }], [image])).toEqual([image]);
  });

  it("accepts images and general files supported by the shared upload endpoint", () => {
    const candidates = [
      file("screen.png", "image/png"),
      file("context.pdf", "application/pdf"),
      file("logs.txt", "text/plain"),
      file("bundle.zip", "application/zip"),
    ];
    expect(selectComposerFiles([], candidates)).toEqual({ accepted: candidates, error: undefined });
  });

  it("rejects unsupported, oversized, and over-total files before upload", () => {
    const eightMiB = 8 * 1024 * 1024;
    const current = [file("one.pdf", "application/pdf", eightMiB), file("two.pdf", "application/pdf", eightMiB)];
    const candidates = [
      file("three.pdf", "application/pdf", eightMiB),
      file("too-large.pdf", "application/pdf", eightMiB + 1),
      file("script.html", "text/html"),
    ];
    const result = selectComposerFiles(current, candidates);
    expect(result.accepted).toEqual([candidates[0]]);
    expect(result.error).toContain("2 pasted or selected files were not attached");
  });

  it("atomically caps rapid duplicate paste events at four files", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (value) => `blob:${(value as File).name}`;
    URL.revokeObjectURL = () => undefined;
    let sent: File[] = [];
    const view = create(<Composer disabled={false} running={false} onSend={(_text, files) => { sent = files; }} />);
    const textarea = pasteTarget(view);
    const first = [1, 2, 3, 4].map((index) => file(`first-${index}.png`, "image/png"));
    const second = [1, 2, 3, 4].map((index) => file(`second-${index}.png`, "image/png"));

    unstable_batchedUpdates(() => {
      textarea.props.onPaste(clipboard(first));
      textarea.props.onPaste(clipboard(second));
    });
    view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Send message")[0]!.props.onClick();

    expect(sent).toHaveLength(4);
    expect(sent).toEqual(first);
    view.unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("atomically caps rapid paste events at the 24 MiB aggregate and exposes rejection", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (value) => `blob:${(value as File).name}`;
    URL.revokeObjectURL = () => undefined;
    let sent: File[] = [];
    const view = create(<Composer disabled={false} running={false} onSend={(_text, files) => { sent = files; }} />);
    const textarea = pasteTarget(view);
    const eightMiB = 8 * 1024 * 1024;

    unstable_batchedUpdates(() => {
      textarea.props.onPaste(clipboard([file("one.pdf", "application/pdf", eightMiB), file("two.pdf", "application/pdf", eightMiB)]));
      textarea.props.onPaste(clipboard([file("three.pdf", "application/pdf", eightMiB), file("four.pdf", "application/pdf", eightMiB)]));
    });
    expect(view.root.findAll((node) => node.children.some((child) => typeof child === "string" && child.includes("not attached")))).not.toHaveLength(0);
    view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Send message")[0]!.props.onClick();

    expect(sent).toHaveLength(3);
    expect(sent.reduce((total, value) => total + value.size, 0)).toBe(24 * 1024 * 1024);
    view.unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("leaves plain text paste alone and ignores file paste while disabled or running", () => {
    for (const props of [{ disabled: true, running: false }, { disabled: false, running: true }]) {
      let prevented = false;
      const view = create(<Composer {...props} onSend={() => undefined} />);
      const textarea = pasteTarget(view);
      textarea.props.onPaste({ clipboardData: { items: [{ kind: "string", getAsFile: () => null }], files: [] }, preventDefault: () => { prevented = true; } });
      textarea.props.onPaste({ ...clipboard([file("screen.png", "image/png")]), preventDefault: () => { prevented = true; } });
      expect(prevented).toBe(false);
      view.unmount();
    }
  });

  it("revokes live object URLs only when the Composer unmounts", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    URL.revokeObjectURL = (value) => { revoked.push(value); };
    const created: string[] = [];
    URL.createObjectURL = (value) => {
      const url = `blob:${(value as File).name}:${created.length}`;
      created.push(url);
      return url;
    };
    const view = create(<StrictMode><Composer disabled={false} running={false} onSend={() => undefined} /></StrictMode>);
    pasteTarget(view).props.onPaste(clipboard([file("screen.png", "image/png")]));
    expect(revoked).toEqual([]);
    view.update(<StrictMode><Composer disabled={false} running={false} onSend={() => undefined} placeholder="Updated" /></StrictMode>);
    expect(revoked).toEqual([]);
    view.unmount();
    expect(revoked).toEqual(created);
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("revokes preview URLs on remove and after a successful send", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    URL.createObjectURL = (value) => `blob:${(value as File).name}`;
    URL.revokeObjectURL = (value) => { revoked.push(value); };
    const view = create(<Composer disabled={false} running={false} onSend={() => undefined} />);
    pasteTarget(view).props.onPaste(clipboard([file("remove.png", "image/png"), file("send.png", "image/png")]));
    view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Remove remove.png")[0]!.props.onClick();
    expect(revoked).toContain("blob:remove.png");
    view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Send message")[0]!.props.onClick();
    await Promise.resolve();
    expect(revoked).toEqual(expect.arrayContaining(["blob:remove.png", "blob:send.png"]));
    view.unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });
});
