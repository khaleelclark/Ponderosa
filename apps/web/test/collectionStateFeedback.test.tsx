import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CollectionStateFeedback,
  CollectionWorkspace,
} from "../src/components/CollectionPrimitives";
import type { WorkspaceDirectoryRequestState } from "../src/hooks/useWorkspaceDirectory";

function state(
  override: Partial<WorkspaceDirectoryRequestState> = {},
): WorkspaceDirectoryRequestState {
  return {
    hasResolved: false,
    isInitialLoading: false,
    isRefreshing: false,
    isInitialError: false,
    isPaginationError: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    retry: vi.fn().mockResolvedValue(undefined),
    fetchNextPage: vi.fn().mockResolvedValue(undefined),
    ...override,
  };
}

describe("shared collection request feedback", () => {
  it("never presents unresolved data as an empty collection", () => {
    render(
      <CollectionStateFeedback
        request={state({ isInitialLoading: true })}
        itemCount={0}
        filtersActive={false}
        resourceLabel="Agents"
        emptyTitle="No Agents"
      />,
    );
    expect(screen.getByText("Loading Agents…")).not.toBeNull();
    expect(screen.queryByText("No Agents")).toBeNull();
  });

  it("offers initial retry and preserves content during pagination failure", async () => {
    const user = userEvent.setup();
    const retry = vi.fn().mockResolvedValue(undefined);
    const first = render(
      <CollectionStateFeedback
        request={state({ isInitialError: true, retry })}
        itemCount={0}
        filtersActive={false}
        resourceLabel="Projects"
        emptyTitle="No Projects"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    first.unmount();

    const fetchNextPage = vi.fn().mockResolvedValue(undefined);
    render(
      <div>
        <div>Existing Agent</div>
        <CollectionStateFeedback
          request={state({
            hasResolved: true,
            isPaginationError: true,
            fetchNextPage,
          })}
          itemCount={1}
          filtersActive={false}
          resourceLabel="Agents"
          emptyTitle="No Agents"
        />
      </div>,
    );
    expect(screen.getByText("Existing Agent")).not.toBeNull();
    expect(screen.getByText(/Existing results are still available/)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("exposes collection busy state without replacing loaded children", () => {
    render(
      <CollectionWorkspace
        title="Agents"
        toolbar={<div>Toolbar</div>}
        listLabel="Agent collection"
        busy
      >
        <div>Loaded Agent</div>
      </CollectionWorkspace>,
    );
    expect(
      screen.getByRole("region", { name: "Agent collection" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.getByText("Loaded Agent")).not.toBeNull();
  });
});
