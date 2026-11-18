// Shared by initial Core navigation and the recoverable workspace route.
export const loadProjectShell = () => import("./components/ProjectShell").then(module => ({ default: module.ProjectShell }));

// Canonical first-use loaders share one optional entry to avoid fragmenting cold route code.
const loadOptionalProjectPanels = () => import("./components/ProjectOptionalPanels");
export const loadAgentWorkInspector = () => loadOptionalProjectPanels().then(module => ({ default: module.AgentWorkInspector }));
export const loadProjectBrowserDialog = () => loadOptionalProjectPanels().then(module => ({ default: module.ProjectBrowserDialog }));
export const loadAgentBrowserDialog = () => loadOptionalProjectPanels().then(module => ({ default: module.AgentBrowserDialog }));
export const loadWorkspaceReviewPane = () => loadOptionalProjectPanels().then(module => ({ default: module.WorkspaceReviewPane }));
export const loadWorkspaceFileView = () => loadOptionalProjectPanels().then(module => ({ default: module.WorkspaceFileView }));
