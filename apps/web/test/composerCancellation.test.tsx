import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerSendActions } from "../src/components/chat/Composer.parts";

describe("Composer cancellation feedback", () => {
  it("acknowledges a pending cancellation and blocks repeat submission", () => {
    const onCancel = vi.fn();
    const props = {
      allowSendWhileRunning: false,
      canCancel: true,
      canSend: false,
      destinationError: undefined,
      destinationMode: "project-chat" as const,
      mentionedBusyHandles: [],
      onCancel,
      queue: vi.fn(),
      recipientRequiredMessage: undefined,
      send: vi.fn(),
      showQueue: false,
      steer: vi.fn(),
      targetRequiredRecipientTagged: true,
    };
    const view = render(
      <ComposerSendActions {...props} cancelPending />,
    );

    const pendingButton = screen.getByRole("button", {
      name: "Cancelling…",
    });
    expect(pendingButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(pendingButton);
    expect(onCancel).not.toHaveBeenCalled();

    view.rerender(
      <ComposerSendActions {...props} cancelPending={false} />,
    );
    const readyButton = screen.getByRole("button", {
      name: "Cancel run",
    });
    expect(readyButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(readyButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
