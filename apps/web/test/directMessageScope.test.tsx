import { createTheme, ThemeProvider } from "@mui/material";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  DirectMessageScope,
  DIRECT_SCOPE_EXPLANATION,
} from "../src/components/chat/DirectMessageScope";
import { ChatPane } from "../src/components/chat/ChatPane";

describe("DirectMessageScope", () => {
  it("labels both sides of a Direct exchange in Agent Chat", () => {
    const directMessageAgents = [{ id: "spruce", title: "Spruce" }];
    render(
      <ChatPane
        agentName="Spruce"
        agentNameForId={() => "Spruce"}
        projectId="project-one"
        messages={[
          {
            id: "direct-user",
            communicationEventId: "direct-user-event",
            communicationIntent: "user_dm",
            directMessageAgents,
            agentId: "spruce",
            seq: 1,
            role: "user",
            text: "Private question",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
          {
            id: "direct-agent",
            communicationEventId: "direct-agent-event",
            communicationIntent: "user_dm",
            directMessageAgents,
            agentId: "spruce",
            seq: 2,
            role: "assistant",
            authorAgentId: "spruce",
            text: "Private answer",
            createdAt: "2026-08-01T00:01:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getAllByText("Direct · You ↔ Spruce")).toHaveLength(2);
  });

  it.each(["light", "dark"] as const)(
    "stays compact and accessible in %s mode",
    async (mode) => {
      const user = userEvent.setup();
      render(
        <ThemeProvider theme={createTheme({ palette: { mode } })}>
          <DirectMessageScope agents={[
            { id: "spruce", title: "Spruce" },
            { id: "cedar", title: "Cedar With A Long Display Name" },
            { id: "fir", title: "Fir" },
          ]} />
        </ThemeProvider>,
      );

      const scope = screen.getByLabelText(
        `Direct · You ↔ Spruce, Cedar With A Long Display Name +1. ${DIRECT_SCOPE_EXPLANATION}`,
      );
      expect(scope).toBeTruthy();
      await user.hover(scope);
      expect((await screen.findByRole("tooltip")).textContent).toContain(
        DIRECT_SCOPE_EXPLANATION,
      );
    },
  );
});
