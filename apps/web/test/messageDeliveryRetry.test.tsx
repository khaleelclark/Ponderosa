import { Button } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { MessageDeliveryStatus } from "../src/components/MessageDeliveryStatus";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Dialog: forwardRef<HTMLDivElement, { open: boolean; children?: React.ReactNode }>(({ open, children }, ref) =>
      open ? createElement("div", { ref }, children) : null),
    ButtonBase: forwardRef<HTMLButtonElement, Record<string, unknown> & { children?: React.ReactNode }>(({ children, ...props }, ref) =>
      createElement("button", { ...props, ref }, children)),
  };
});

describe("message delivery retry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires confirmation for uncertain delivery and uses a stable attempt key", async () => {
    const retry = vi.spyOn(api, "retryMessageDelivery").mockResolvedValue({
      accepted: true,
      replayed: false,
      state: "queued",
      activationId: "retry-activation",
      targetAgentId: "manager",
      retryMayDuplicate: true,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><MessageDeliveryStatus
        projectId="project-a"
        receipts={[{
          activationId: "uncertain-activation",
          targetAgentId: "manager",
          state: "undelivered",
          updatedAt: "2026-07-19T00:00:00.000Z",
          attemptCount: 1,
          canRetry: true,
          retryMayDuplicate: true,
        }]}
        recipientName={() => "Manager"}
      /></QueryClientProvider>);
    });

    const buttonNamed = (name: string) => view.root.findAllByType(Button)
      .find((button) => button.props.children === name)!;
    await act(async () => { buttonNamed("Retry").props.onClick(); });
    expect(JSON.stringify(view.toJSON())).toContain("may have reached the provider");
    expect(retry).not.toHaveBeenCalled();

    await act(async () => { await buttonNamed("Retry anyway").props.onClick(); });
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith("project-a", "uncertain-activation", {
      idempotencyKey: "operator-delivery-retry:uncertain-activation",
    });
    view.unmount();
    client.clear();
  });
});
