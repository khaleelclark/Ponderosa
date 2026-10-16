import { admitDataDirectory, readCurrentStateIdentity, type StateAdmission } from "./state-admission.js";
export type DataDirectoryOwnership = StateAdmission;
export const acquireDataDirectoryOwnership = admitDataDirectory;
export function releaseDataDirectoryOwnership(ownership: StateAdmission | undefined): void { ownership?.close(); }
export function ensureCurrentDataLayout(dataDir: string): void { readCurrentStateIdentity(dataDir); }
