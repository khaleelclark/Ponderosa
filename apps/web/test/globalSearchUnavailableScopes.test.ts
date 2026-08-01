import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnavailableGlobalSearchScopeChip } from "../src/components/GlobalChatSearch";

describe("unavailable global-search scopes", () => {
  it.each(["Projects", "Files"] as const)("renders %s as a focusable, disabled explanation", (scope) => {
    render(createElement(UnavailableGlobalSearchScopeChip, { scope }));

    const visibleLabel = `${scope} · Coming later`;
    const chip = screen.getByRole("button", { name: new RegExp(`^${scope} · Coming later`, "i") });
    expect(chip.textContent).toBe(visibleLabel);
    expect(chip.getAttribute("aria-label")).toContain(visibleLabel);
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("tabindex")).toBe("0");
  });
});
