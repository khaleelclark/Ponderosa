// Shared by initial Core navigation and the recoverable workspace route.
export const loadProjectShell = () => import("./components/ProjectShell").then(module => ({ default: module.ProjectShell }));

// Canonical first-use loaders shared by the existing optional panel callers.
export const loadAgentWorkInspector = () => import("./components/AgentWorkInspector").then(module => ({ default: module.AgentWorkInspector }));

export const loadProjectBrowserDialog = () => import("./components/ProjectBrowserDialog").then(module => ({ default: module.ProjectBrowserDialog }));

export const loadAgentBrowserDialog = () => import("./components/AgentBrowserDialog").then(module => ({ default: module.AgentBrowserDialog }));

export const loadWorkspaceReviewPane = () => import("./components/files/WorkspaceReviewPane").then(module => ({ default: module.WorkspaceReviewPane }));

export const loadWorkspaceFileView = () => import("./components/WorkspaceFileView").then(module => ({ default: module.WorkspaceFileView }));
