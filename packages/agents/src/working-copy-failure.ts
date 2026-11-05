import type { AgentWorkingCopyDto } from "@ponderosa/core";

// Only fixed, application-authored explanations can cross this boundary.
// Tool stderr, OS messages, stored legacy text and arbitrary error codes may
// contain credentials, so unknown text is never copied into public DTOs.
const fixed = new Set<string>([
  "A selected bare common-storage root cannot also become a Separate Git working tree; choose a distinct storage subfolder or retain its Shared folder mode",
  "Agent became unavailable while changing its working folder",
  "Agent became unavailable while recording working-copy cleanup",
  "Choose the exact canonical contained-root relation",
  "Contained Shared alias requires the exact fenced canonical root owner",
  "Contained allocation followed an unexpected parent",
  "Contained allocation has no fresh canonical parent",
  "Contained allocation intermediate parent changed",
  "Contained allocation is already attempted or exceeds its root bound; inspect its exact receipt",
  "Contained allocation parent was replaced",
  "Contained allocation requires the parent working-folder fence",
  "Contained binding has no exact local reservation; inspect the original preparation after a restart",
  "Contained binding requires the child working-folder fence",
  "Contained binding root changed; retain its exact binding receipt",
  "Contained native Git import is in progress; inspect its exact preparation receipt.",
  "Contained reservation is already binding or bound; inspect its exact child identity",
  "Contained root escaped its issued parent",
  "Contained root lost its locally issued parent/child inode custody",
  "Contained working root custody changed",
  "Deleted Agent became unavailable while recording working-copy cleanup",
  "Final Project binding requires its exact locally created contained-root receipt",
  "Final contained Project binding requires every destination owner fence",
  "Final contained Project binding requires every preparing owner fence",
  "Final live metadata requires its fenced imported destination",
  "Final metadata root lost its fresh local custody",
  "Fresh native Project root changed before initialization",
  "Generated hook issuance lost exact current owner custody",
  "Git adoption lost exact current Agent custody",
  "Imported Git canonical ownership changed during final metadata",
  "Imported Git owner Project disappeared",
  "Imported Separate Git ownership changed before activation",
  "Imported recovery Git root lost its exact new-directory identity",
  "Imported repository ownership path changed; preserve its data",
  "Imported root changed before metadata",
  "Independent Git import requires exclusive working-copy custody",
  "Independent Git import requires the fresh destination Agent",
  "Independent imported Git creation is incomplete or released. Inspect its exact import operation for recovery; do not retry it as a Project-linked working copy.",
  "Independent imported Git repository has no local managed ownership",
  "Independent imported Git root changed; preserve its data",
  "Invalid contained destination working-copy mode",
  "Invalid contained-root relation",
  "Live Shared import requires the empty NEW managed Chat folder",
  "Live import was not fenced",
  "Managed import parent changed",
  "Metadata root membership changed",
  "Native Git differs from its exact local before-population ownership proof; preserve partial application",
  "Native Git final metadata is pending; preserve its exact import operation.",
  "Native Git import is in progress; preserve partial data and inspect its import receipt.",
  "Native Git import proof is incomplete; preserve its exact root and original import operation.",
  "Native Git requires the unused NEW managed Project",
  "Native Shared Git requires the unused NEW managed Chat",
  "Native Shared activation requires the NEW managed import destination",
  "Native activation original is unavailable or changed",
  "Native activation root membership changed",
  "Native import current owner is outside its selected root closure",
  "Native import metadata and ownership proof are pending; preserve the exact import operation.",
  "Native import requires every current root owner fence",
  "Native import root is not in its exact populated phase",
  "Native import root must be freshly allocated and empty",
  "Native metadata requires the original and a NEW managed destination",
  "Prepared import canonical owner changed",
  "Prepared import contained-root custody changed",
  "Prepared import inspection requires its Agent fence",
  "Prepared import root lost its local inode custody",
  "Separate Git copy contains changed, untracked or ignored files and was preserved. Save them in Shared before retrying removal.",
  "Separate Git copy contains commits absent from Shared and was preserved. Merge or save them in Shared before retrying removal.",
  "Separate Git copy creation is in progress. Runs remain paused.",
  "Separate Git copy is being prepared. Runs remain paused.",
  "Separate Git copy removal is in progress. Runs remain paused.",
  "Shared contained root must match the explicitly registered destination Project",
  "Staged Git root changed before byte-phase identity handoff",
  "Staged Git root changed or population was already attempted",
  "The Project Shared folder is not the root of its Git repository",
  "The Project Shared folder is unavailable; the retained Git copy was preserved",
  "The newly allocated managed branch collides with imported user refs",
  "The retained Git branch changed after cleanup was authorized and was preserved",
  "The retained Git branch changed before cleanup ownership was recorded and was preserved",
  "The retained Git branch has no cleanup ownership marker and was preserved",
  "The retained Git cleanup ownership marker changed and was preserved",
  "The retained Git cleanup ownership proof changed and the branch was preserved",
  "The retained Git copy has an invalid branch-creation receipt",
  "The retained Git copy has an invalid cleanup receipt",
  "The retained Git copy no longer matches its durable branch and working-folder identity",
  "The retained Git working folder was replaced and was preserved",
  "The retained Git worktree registration changed after cleanup and was preserved",
  "The retained Git worktree registration remains after cleanup",
  "The retained Separate Git copy has no durable branch identity",
  "The retained Separate Git copy is not a managed directory",
  "The retained Separate Git copy is outside its managed location",
  "The retained Separate Git copy resolves somewhere else",
  "The retained Separate Git copy still has a working-folder registration and was preserved",
  "This Agent's Separate Git copy identity is incomplete.",
  "This Agent's Shared folder identity is inconsistent with its Project.",
  "This Agent's working folder belongs to a different Project.",
  "This Agent's working folder changed before the Run started; retry safely",
  "This Agent's working folder is already changing",
  "This Agent's working folder is changing; retry the Run safely",
  "This Agent's working folder is changing; retry the provider command safely",
  "This Agent's working folder is unavailable; inspect its status before retrying.",
  "This deleted Agent has no retained Separate Git copy",
  "Working-folder change was not fenced before it began",
  "the Project Shared folder is not the root of its Git repository",
  "the Separate Git target was replaced and was preserved",
  "the branch-creation ownership ref changed and was preserved",
  "the branch-creation ownership ref exists without its atomic branch",
  "the configured Separate Git copy is not registered by its Project repository",
  "the configured Separate Git copy is outside managed storage",
  "the configured Separate Git copy no longer matches its branch",
  "the configured root is not a retained directory",
  "the configured root resolves somewhere else",
  "the existing Git branch is not proven to be Ponderosa-owned",
  "the interrupted Git copy no longer matches its creation receipt",
  "the managed working-copy parent was replaced and was preserved",
  "the owned Git branch is no longer registered to its working folder",
  "the prepared Separate Git copy has a different root",
  "the requested Git branch already exists and is not Ponderosa-owned",
  "the requested Git branch does not match its atomic creation receipt",
  "the requested Git branch is registered to another working folder",
]);
const legacyPrefix = "Separate Git copy is unavailable. ";
function fixedReason(value: string): boolean {
  return fixed.has(value) || (value.startsWith(legacyPrefix) && fixed.has(value.slice(legacyPrefix.length)));
}
const systemCodes: Readonly<Record<string, string>> = {
  ENOENT: "A required file or folder was not found.",
  ENOTDIR: "A required folder is not a directory.",
  EACCES: "Access to a required file or folder was denied.",
  EPERM: "The operating system denied the operation.",
  ENOSPC: "The storage volume has no available space.",
  EDQUOT: "The storage quota was exceeded.",
  EROFS: "The storage volume is read-only.",
  EEXIST: "A required destination already exists.",
  EBUSY: "A required file or folder is busy.",
};
const generic = "The working folder could not be changed safely; unverified error details were withheld.";
const legacyWithheld = "Previously recorded working-folder error details are withheld.";

export function safeWorkingCopyFailure(error: unknown): string {
  if (error instanceof Error && fixedReason(error.message)) return error.message;
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(systemCodes, code) ? systemCodes[code]! : generic;
}

export function safeWorkingCopyFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(systemCodes, code) ? code : "ERR_IMPORTED_GIT_ADOPTION_PARTIAL";
}

export function safeStoredWorkingCopy(copy: AgentWorkingCopyDto): AgentWorkingCopyDto {
  return copy.failure === undefined ? copy : { ...copy, failure: fixedReason(copy.failure) || Object.values(systemCodes).includes(copy.failure) || copy.failure === generic ? copy.failure : legacyWithheld };
}

/** A read projection must not erase an older stored diagnostic when an
 * unrelated update spreads that projected copy. A newly assigned failure,
 * including a new generic failure, replaces it as usual. */
export function preserveStoredWorkingCopy(previous: AgentWorkingCopyDto, next: AgentWorkingCopyDto): AgentWorkingCopyDto {
  if (next.id === previous.id && next.failure === legacyWithheld &&
      previous.failure !== undefined && safeStoredWorkingCopy(previous).failure === legacyWithheld) {
    return { ...next, failure: previous.failure };
  }
  return next;
}
