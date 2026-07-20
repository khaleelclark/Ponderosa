import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { copyText } from "../src/clipboard";
import { EventLine } from "../src/components/panes";

vi.mock("../src/clipboard", () => ({ copyText: vi.fn() }));

describe("command activity copy", () => {
  it("copies the exact command and announces accessible success feedback", async () => {
    vi.mocked(copyText).mockResolvedValue();
    const view = create(<EventLine item={{
      id: "command-1",
      seq: 7,
      ts: "2026-07-20T12:00:00.000Z",
      event: { type: "command", command: "pnpm --filter @ponderosa/web test", cwd: "/repo" },
    }} />);

    const copy = view.root.findByProps({ "aria-label": "Copy command" });
    await act(async () => copy.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() }));

    expect(copyText).toHaveBeenCalledWith("pnpm --filter @ponderosa/web test");
    expect(view.root.findByProps({ "aria-live": "polite" }).props.children).toBe("Command copied");
    view.unmount();
  });
});
