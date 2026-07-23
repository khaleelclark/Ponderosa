import { Button } from "@mui/material";
import { useState } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceErrorBoundary } from "../src/components/WorkspaceErrorBoundary";

function BrokenRoute({ broken }: { broken: boolean }): JSX.Element {
  if (broken) throw new Error("route render failed");
  return <section aria-label="Recovered route">Recovered workspace content</section>;
}

describe("workspace route feature boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps surrounding navigation accessible and retries the failed route body", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let broken = true;
    const shell = () => (
      <main>
        <nav aria-label="Workspace sidebar">Sidebar</nav>
        <nav aria-label="Open workspace tabs">Tabs</nav>
        <WorkspaceErrorBoundary title="Collection failed">
          <BrokenRoute broken={broken} />
        </WorkspaceErrorBoundary>
      </main>
    );
    const view = create(shell());

    expect(view.root.findByProps({ "aria-label": "Workspace sidebar" })).toBeTruthy();
    expect(view.root.findByProps({ "aria-label": "Open workspace tabs" })).toBeTruthy();
    expect(view.root.findByProps({ role: "alert" })).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain("Your other Ponderosa tabs and navigation are still available.");

    broken = false;
    act(() => view.update(shell()));
    act(() => view.root.findByType(Button).props.onClick());
    expect(view.root.findByProps({ "aria-label": "Recovered route" })).toBeTruthy();
    expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    view.unmount();
  });

  it("clears a failed collection when workspace navigation selects another route", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Harness(): JSX.Element {
      const [route, setRoute] = useState<"collection" | "settings">("collection");
      return <main>
        <nav aria-label="Workspace sidebar">
          <button onClick={() => setRoute("settings")}>Open Settings</button>
        </nav>
        <nav aria-label="Open workspace tabs">Tabs</nav>
        <WorkspaceErrorBoundary resetKey={route}>
          <BrokenRoute broken={route === "collection"} />
        </WorkspaceErrorBoundary>
      </main>;
    }

    const view = create(<Harness />);
    expect(view.root.findByProps({ role: "alert" })).toBeTruthy();
    act(() => view.root.findByProps({ children: "Open Settings" }).props.onClick());
    expect(view.root.findByProps({ "aria-label": "Recovered route" })).toBeTruthy();
    expect(view.root.findByProps({ "aria-label": "Workspace sidebar" })).toBeTruthy();
    expect(view.root.findByProps({ "aria-label": "Open workspace tabs" })).toBeTruthy();
    view.unmount();
  });
});
