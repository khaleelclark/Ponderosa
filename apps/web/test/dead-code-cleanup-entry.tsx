// Reuse the disposable real-App fixture; no provider, saved browser or live APIs.
import "./files-results-app-browser-entry";
import { api } from "../src/api";

api.markWorkspaceResourceUsed = async ({ kind, resourceId }) => ({
  kind, resourceId, resourceKey: `${kind}:${resourceId}`, lastUsedAt: "2026-10-08T00:00:00Z",
});
api.markProjectUsed = async () => {};
api.getWorkspaceFileView = async (projectId, pathname) => ({
  projectId, name: "fixture.txt", path: pathname, mediaType: "text/plain", size: 15,
  previewable: true, truncated: false, text: "Disposable file",
});
