import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectDto } from "@ponderosa/core";
import { ProviderActivitySettingsSection } from "../src/components/WorkspaceResourceViews";
import { createPonderosaTheme } from "../src/theme";
import { queryKeys } from "../src/queryKeys";

const projects = Array.from({ length: 250 }, (_, index) => ({ id: `project-${index}`, label: `Folder ${index}`, hostPath: `/fixture/${index}`, defaultEngine: "codex" })) as ProjectDto[];
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
// A management view previously collected many pages. Activity must not reuse
// or automatically refetch that complete collection.
for (const kind of ["conversation", "agent"] as const) client.setQueryData(
  queryKeys.workspaceDirectory.list(kind, "", undefined, undefined, undefined, undefined, undefined, undefined, undefined),
  { pages: Array.from({ length: 20 }, (_, index) => ({ kind, items: [], starredItems: [], total: 500, history: { hasMore: true, cursor: String((index + 1) * 25) } })),
    pageParams: Array.from({ length: 20 }, (_, index) => index ? String(index * 25) : undefined) }, { updatedAt: 1 });
Object.assign(window, { refreshScopes: () => client.refetchQueries({ queryKey: ["workspace-directory", "conversation"] }) });
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}>
    <ProviderActivitySettingsSection projects={projects} />
  </QueryClientProvider>
</ThemeProvider>);
