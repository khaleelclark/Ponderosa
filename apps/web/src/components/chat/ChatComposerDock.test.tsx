import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatComposerDock } from "./ChatComposerDock";

afterEach(cleanup);

describe("ChatComposerDock", () => {
  it("keeps the composer mounted in normal document layout", () => {
    render(
      <ChatComposerDock>
        <textarea aria-label="Message" />
      </ChatComposerDock>,
    );

    const dock = screen.getByRole("textbox").closest("[data-chat-composer-dock]");
    expect(dock).not.toBeNull();
    expect(dock!.hasAttribute("data-mobile-composer-hidden")).toBe(false);
    expect(getComputedStyle(dock!).position).toBe("static");
  });
});
