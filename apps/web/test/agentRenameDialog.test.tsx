import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRenameDialog } from "../src/components/AgentDetail.parts";

function props(overrides: Record<string, unknown> = {}) {
  return {
    renameOpen: true,
    setRenameOpen: vi.fn(),
    renameValue: "Crater Lake",
    setRenameValue: vi.fn(),
    rename: {
      isError: false,
      isPending: false,
      error: undefined,
      mutate: vi.fn(),
    },
    ...overrides,
  };
}

describe("AgentRenameDialog", () => {
  it("labels and describes the Agent name field and submits valid names with Enter", async () => {
    const user = userEvent.setup();
    const rename = {
      isError: false,
      isPending: false,
      error: undefined,
      mutate: vi.fn(),
    };
    render(<AgentRenameDialog {...props({ rename })} />);

    const field = screen.getByRole("textbox", { name: "Agent name" });
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(/Spaces are supported/)).not.toBeNull();
    await user.click(field);
    await user.keyboard("{Enter}");
    expect(rename.mutate).toHaveBeenCalledWith("Crater Lake");
  });

  it("returns focus to the name field after a failed rename", async () => {
    const user = userEvent.setup();
    const initial = props();
    const view = render(<AgentRenameDialog {...initial} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const failed = {
      isError: true,
      isPending: false,
      error: new Error("Name is already used"),
      mutate: vi.fn(),
    };
    view.rerender(<AgentRenameDialog {...props({ rename: failed })} />);
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Agent name" }),
    );
  });
});
