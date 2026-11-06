// Shared by initial Core navigation and the recoverable workspace route.
export const loadProjectShell = () => import("./components/ProjectShell").then(module => ({ default: module.ProjectShell }));
