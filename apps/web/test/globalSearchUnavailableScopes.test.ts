import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnavailableGlobalSearchScopeChip } from "../src/components/GlobalChatSearch";

describe("unavailable global-search scopes", () => {
  it.each(["Projects", "Files"] as const)("renders %s as a focusable, disabled explanation", (scope) => {
    render(createElement(UnavailableGlobalSearchScopeChip, { scope }));

    const chip = screen.getByRole("button", { name: new RegExp(`${scope} search is coming later`, "i") });
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("tabindex")).toBe("0");
  });
});
