import { type StateAdmission } from "./state-admission.js";
export type DataDirectoryOwnership = StateAdmission;
export function releaseDataDirectoryOwnership(ownership: StateAdmission | undefined): void { ownership?.close(); }
