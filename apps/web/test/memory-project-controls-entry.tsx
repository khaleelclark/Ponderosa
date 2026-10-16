import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider, Button, Stack } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import type { ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { createPonderosaTheme } from "../src/theme";
import { ProjectSettingsPanel } from "../src/components/ProjectSettingsPanel";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";

// Metadata is disposable fixture state. All memory methods are the real API.
const params = new URLSearchParams(location.search);
const projects = JSON.parse(params.get("projects")!) as ProjectDto[];
const preferences = { claudeModelOptions: [] } as unknown as WorkspacePreferencesDto;
function Fixture(): JSX.Element {
  const [index, setIndex] = useState(0);
  return <Stack><Button onClick={() => setIndex(i => 1 - i)}>Switch fixture Project</Button>
    <ProjectSettingsPanel project={projects[index]!} engines={[]} preferences={preferences} onDeleted={() => {}} /></Stack>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MutationNotificationProvider><Fixture /></MutationNotificationProvider>
  </QueryClientProvider></ThemeProvider></StrictMode>);
