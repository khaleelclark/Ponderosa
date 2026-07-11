import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserMessageLabel } from "../src/components/panes";

describe("UserMessageLabel", () => {
  it("renders a visible text label for sighted and screen-reader users", () => {
    const html = renderToStaticMarkup(<UserMessageLabel />);

    expect(html).toContain(">User</div>");
    expect(html).not.toContain("aria-hidden");
  });
});
