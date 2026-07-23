import { describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { create, unstable_batchedUpdates } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import {
  Composer,
  composerSubmissionText,
  filesFromClipboard,
  replyPreviewText,
  selectComposerFiles,
  shouldExtractLongPaste,
} from "../src/components/panes";

const file = (name: string, type: string, size = 4) => {
  const value = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  Object.defineProperty(value, "size", { value: size });
  return value;
};
const clipboard = (files: File[]) => ({
  clipboardData: {
    items: files.map((value) => ({ kind: "file", getAsFile: () => value })),
    files,
    getData: () => "",
  },
  preventDefault: () => undefined,
});
const textClipboard = (value: string) => ({
  clipboardData: { items: [], files: [], getData: () => value },
  preventDefault: vi.fn(),
});
const pasteTarget = (view: ReturnType<typeof create>) => view.root.findAll((node) => typeof node.props.onPaste === "function")[0]!;
const renderComposer = (element: ReactElement) => create(<QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>);

describe("composer clipboard attachments", () => {
  it("uses Unicode code points for the inclusive 10,000-character paste boundary", () => {
    expect(shouldExtractLongPaste("😀".repeat(10_000))).toBe(false);
    expect(shouldExtractLongPaste("😀".repeat(10_001))).toBe(true);
    expect(composerSubmissionText("Please inspect this", "full pasted body")).toBe("Please inspect this\n\nfull pasted body");
  });

  it("turns long pasted text into a removable chip and submits its full content", async () => {
    let sent = "";
    const view = renderComposer(<Composer disabled={false} running={false} onSend={(text) => { sent = text; }} />);
    const textarea = pasteTarget(view);
    const longPaste = "p".repeat(10_001);
    const paste = textClipboard(longPaste);
    textarea.props.onPaste(paste);
    expect(paste.preventDefault).toHaveBeenCalledOnce();
    expect(view.root.findAll((node) => node.children.includes("Pasted text"))).not.toHaveLength(0);
    textarea.props.onChange({ target: { value: "Summarize this", selectionStart: 14 } });
    view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Send message")[0]!.props.onClick();
    await Promise.resolve();
    expect(sent).toBe(`Summarize this\n\n${longPaste}`);
    view.unmount();
  });

  it("keeps context guidance and the capability trigger inside the shared composer shell", () => {
    const view = renderComposer(<Composer
      disabled={false}
      running={false}
      guidance="Use #agent to target an agent and @ to reference a file."
      capabilities={[{ id: "skill:review", kind: "skill", label: "review", description: "Review changes", status: "available", insertText: "$review " }]}
      onSend={() => undefined}
    />);
    expect(view.root.findAll((node) => node.children.includes("Use #agent to target an agent and @ to reference a file."))).not.toHaveLength(0);
    expect(view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Add attachment or capability")).toHaveLength(1);
    expect(view.root.findAll((node) => node.props.variant === "standard" && node.props.multiline)).toHaveLength(1);
    view.unmount();
  });

  it("refreshes runtime discovery whenever the capability menu opens", () => {
    const refresh = vi.fn();
    const view = renderComposer(<Composer
      disabled={false}
      running={false}
      capabilities={[]}
      onCapabilitiesOpen={refresh}
      onSend={() => undefined}
    />);
    const trigger = view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Add attachment or capability")[0]!;
    trigger.props.onClick({ currentTarget: null });
    expect(refresh).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("bounds long reply previews so the cancel action remains reachable", () => {
    const preview = replyPreviewText(`  ${"long reply segment ".repeat(80)}  `);
    expect(preview.length).toBeLessThanOrEqual(240);
    expect(preview.endsWith("…")).toBe(true);
    expect(replyPreviewText("short reply")).toBe("short reply");
    expect(replyPreviewText("   ")).toBe("Original message unavailable");
  });

  it("locks synchronously against duplicate sends", () => {
    let calls = 0;
    const pending = new Promise<void>(() => undefined);
    const view = renderComposer(<Composer disabled={false} running={false} onSend={() => { calls += 1; return pending; }} />);
    const textarea = pasteTarget(view);
    textarea.props.onChange({ target: { value: "one message", selectionStart: 11 } });
    const send = view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Send message")[0]!;
    send.props.onClick();
    send.props.onClick();
    expect(calls).toBe(1);
    view.unmount();
  });

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

  it("atomically caps rapid duplicate paste events at twenty files", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (value) => `blob:${(value as File).name}`;
    URL.revokeObjectURL = () => undefined;
    let sent: File[] = [];
    const view = renderComposer(<Composer disabled={false} running={false} onSend={(_text, files) => { sent = files; }} />);
    const textarea = pasteTarget(view);
    const first = Array.from({ length: 10 }, (_, index) => file(`first-${index}.png`, "image/png"));
    const second = Array.from({ length: 10 }, (_, index) => file(`second-${index}.png`, "image/png"));

    unstable_batchedUpdates(() => {
      textarea.props.onPaste(clipboard(first));
      textarea.props.onPaste(clipboard(second));
    });
    view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Send message")[0]!.props.onClick();

    expect(sent).toHaveLength(20);
    expect(sent).toEqual([...first, ...second]);
    view.unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("queues an attachment-only draft while an agent is responding", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (value) => `blob:${(value as File).name}`;
    URL.revokeObjectURL = () => undefined;
    let queuedText: string | undefined;
    let queuedFiles: File[] = [];
    const view = renderComposer(
      <Composer
        disabled={false}
        running={false}
        agentResponding
        onSend={() => undefined}
        onQueue={(text, files) => {
          queuedText = text;
          queuedFiles = files;
        }}
      />,
    );
    const image = file("follow-up.png", "image/png");
    pasteTarget(view).props.onPaste(clipboard([image]));

    const queue = view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Queue message")[0]!;
    expect(queue.props.disabled).not.toBe(true);
    queue.props.onClick();
    await Promise.resolve();

    expect(queuedText).toBe("");
    expect(queuedFiles).toEqual([image]);
    view.unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("returns from Queue to ordinary Send after canonical busy state reconnects as available", async () => {
    let sent: { text: string; files: File[] } | undefined;
    const queryClient = new QueryClient();
    const composer = (agentResponding: boolean) => (
      <QueryClientProvider client={queryClient}>
        <Composer
          disabled={false}
          running={false}
          agentResponding={agentResponding}
          onSend={(text, files) => { sent = { text, files }; }}
          onQueue={() => undefined}
        />
      </QueryClientProvider>
    );
    const view = create(composer(true));
    const textarea = pasteTarget(view);
    textarea.props.onChange({ target: { value: "keep this draft", selectionStart: 15 } });

    expect(view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Queue message")).toHaveLength(1);
    expect(textarea.props.inputProps["aria-label"]).toBe("Message");
    expect(textarea.props.inputProps.enterKeyHint).toBe("send");

    view.update(composer(false));
    const reconnectedTextarea = pasteTarget(view);
    expect(view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Queue message")).toHaveLength(0);
    expect(view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Send message")).toHaveLength(1);
    expect(reconnectedTextarea.props.value).toBe("keep this draft");
    expect(reconnectedTextarea.props.inputProps["aria-label"]).toBe("Message");
    expect(reconnectedTextarea.props.inputProps.enterKeyHint).toBe("send");

    let prevented = 0;
    reconnectedTextarea.props.onKeyDown({
      key: "Enter", shiftKey: false, repeat: false, metaKey: false, ctrlKey: false,
      nativeEvent: { isComposing: true }, preventDefault: () => { prevented += 1; },
    });
    expect(sent).toBeUndefined();
    expect(prevented).toBe(0);

    reconnectedTextarea.props.onKeyDown({
      key: "Enter", shiftKey: false, repeat: false, metaKey: false, ctrlKey: false,
      nativeEvent: { isComposing: false }, preventDefault: () => { prevented += 1; },
    });
    await Promise.resolve();
    expect(prevented).toBe(1);
    expect(sent).toEqual({ text: "keep this draft", files: [] });
    view.unmount();
  });

  it("preserves queued text and attachments after failure so the draft can be retried", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (value) => `blob:${(value as File).name}`;
    URL.revokeObjectURL = () => undefined;
    const attempts: Array<{ text: string; files: File[] }> = [];
    let rejectFirst: ((reason: Error) => void) | undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const view = renderComposer(
      <Composer
        disabled={false}
        running={false}
        agentResponding
        onSend={() => undefined}
        onQueue={(text, files) => {
          attempts.push({ text, files });
          return attempts.length === 1 ? firstAttempt : Promise.resolve();
        }}
      />,
    );
    const image = file("retry.png", "image/png");
    const textarea = pasteTarget(view);
    textarea.props.onChange({ target: { value: "after this", selectionStart: 10 } });
    textarea.props.onPaste(clipboard([image]));
    view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Queue message")[0]!.props.onClick();
    rejectFirst!(new Error("temporary queue failure"));
    await firstAttempt.catch(() => undefined);
    await Promise.resolve();

    expect(pasteTarget(view).props.value).toBe("after this");
    expect(view.root.findAll((node) => node.props["aria-label"] === "Remove retry.png").length).toBeGreaterThan(0);
    view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Queue message")[0]!.props.onClick();
    await Promise.resolve();

    expect(attempts).toEqual([
      { text: "after this", files: [image] },
      { text: "after this", files: [image] },
    ]);
    view.unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("atomically caps rapid paste events at the server's 80 MiB aggregate and exposes rejection", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (value) => `blob:${(value as File).name}`;
    URL.revokeObjectURL = () => undefined;
    let sent: File[] = [];
    const view = renderComposer(<Composer disabled={false} running={false} onSend={(_text, files) => { sent = files; }} />);
    const textarea = pasteTarget(view);
    const eightMiB = 8 * 1024 * 1024;

    unstable_batchedUpdates(() => {
      textarea.props.onPaste(clipboard(Array.from({ length: 6 }, (_, index) => file(`first-${index}.pdf`, "application/pdf", eightMiB))));
      textarea.props.onPaste(clipboard(Array.from({ length: 6 }, (_, index) => file(`second-${index}.pdf`, "application/pdf", eightMiB))));
    });
    expect(view.root.findAll((node) => node.children.some((child) => typeof child === "string" && child.includes("not attached")))).not.toHaveLength(0);
    view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Send message")[0]!.props.onClick();

    expect(sent).toHaveLength(10);
    expect(sent.reduce((total, value) => total + value.size, 0)).toBe(80 * 1024 * 1024);
    view.unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("queues an attachment-only busy draft and returns to ordinary Send without losing it", async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (value) => `blob:${(value as File).name}`;
    URL.revokeObjectURL = () => undefined;
    const queued: Array<{ text: string; files: File[] }> = [];
    const client = new QueryClient();
    const attachment = file("busy-context.pdf", "application/pdf");
    const props = {
      disabled: false,
      running: false,
      agentResponding: true,
      onSend: () => undefined,
      onQueue: (text: string, files: File[]) => { queued.push({ text, files }); },
    };
    const view = create(<QueryClientProvider client={client}><Composer {...props} /></QueryClientProvider>);
    pasteTarget(view).props.onPaste(clipboard([attachment]));

    const queue = view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Queue message")[0]!;
    expect(queue.props.disabled).toBeFalsy();
    queue.props.onClick();
    expect(queued).toEqual([{ text: "", files: [attachment] }]);
    await Promise.resolve();

    // A second staged draft survives the canonical busy -> available switch;
    // Queue disappears and the ordinary Send action remains accessible.
    pasteTarget(view).props.onPaste(clipboard([attachment]));
    view.update(<QueryClientProvider client={client}><Composer {...props} agentResponding={false} onQueue={undefined} /></QueryClientProvider>);
    expect(view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Queue message")).toHaveLength(0);
    expect(view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Send message")).toHaveLength(1);
    expect(view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Remove busy-context.pdf")).toHaveLength(1);
    view.unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("leaves plain text paste alone and ignores file paste while disabled or running", () => {
    for (const props of [{ disabled: true, running: false }, { disabled: false, running: true }]) {
      let prevented = false;
      const view = renderComposer(<Composer {...props} onSend={() => undefined} />);
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
    const view = renderComposer(<StrictMode><Composer disabled={false} running={false} onSend={() => undefined} /></StrictMode>);
    pasteTarget(view).props.onPaste(clipboard([file("screen.png", "image/png")]));
    expect(revoked).toEqual([]);
    view.update(<QueryClientProvider client={new QueryClient()}><StrictMode><Composer disabled={false} running={false} onSend={() => undefined} placeholder="Updated" /></StrictMode></QueryClientProvider>);
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
    const view = renderComposer(<Composer disabled={false} running={false} onSend={() => undefined} />);
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
