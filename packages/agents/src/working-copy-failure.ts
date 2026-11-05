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
// Bind native failures to an application-selected operation without trusting
// stderr, argv, paths or user-provided exception text. The original Error is
// left intact so status-based Git control flow continues to work.
type GitOperation = "inspect" | "update";
const gitFailures = new WeakMap<object, string>();
const gitPrefix: Record<GitOperation, string> = {
  inspect: "Git failed while checking the working folder or repository",
  update: "Git failed while changing the working folder or repository",
};
const gitGuidance: Record<GitOperation, string> = {
  inspect: "Check the selected folder and Git repository before trying again.",
  update: "Inspect the folder and Git state before retrying; partial changes may exist.",
};
const gitSuffix = "Additional Git details are not shown because they may contain credentials.";
const notRepository = "Git could not find a repository from the checked folder";
const notRepositoryGuidance = "Check the Agent's working folder; select or initialize a Git repository as appropriate before retrying.";
const unresolvedHead = "Git could not resolve HEAD to a revision";
const unresolvedHeadGuidance = "Check that HEAD points to an existing commit; for a new repository, create an initial commit before retrying.";
const unresolvedHeadStderr = [
  "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
  "Use '--' to separate paths from revisions, like this:",
  "'git <command> [<revision>...] -- [<file>...]'",
].join("\n");
const gitActions = new Set(["status", "rev-list", "rev-parse", "show-ref", "check-ref-format", "worktree", "init", "commit", "symbolic-ref", "update-ref", "hash-object", "commit-tree", "other"]);
const gitSystemCodes: Readonly<Record<string,string>> = {
  ENOENT: "a required file or program was not found", EACCES: "access was denied",
  EPERM: "the operating system denied the operation", ENOSPC: "the storage volume has no available space",
  EDQUOT: "the storage quota was exceeded", EROFS: "the storage volume is read-only",
  EBUSY: "a required file or folder is busy", ETIMEDOUT: "the operation timed out",
};

export function recordWorkingCopyGitFailure(error: unknown, operation: GitOperation, action: string, exactHead = false): void {
  if (!error || typeof error !== "object" || !Object.hasOwn(gitPrefix, operation) || !gitActions.has(action)) return;
  const value = error as {code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown};
  const exitStatus = typeof value.code === "number" ? value.code : value.status;
  let detail = "the cause was not identified";
  if (typeof exitStatus === "number" && Number.isSafeInteger(exitStatus) && exitStatus >= 1 && exitStatus <= 255)
    detail = `exit status ${exitStatus}`;
  else if (typeof value.code === "string" && Object.hasOwn(gitSystemCodes, value.code))
    detail = `system error ${value.code}: ${gitSystemCodes[value.code]}`;
  else if (value.signal === "SIGTERM" || value.signal === "SIGKILL" || value.signal === "SIGINT")
    detail = `stopped by ${value.signal}`;
  // Git is invoked with LC_ALL=C. Accept only this complete literal, never
  // a substring or a path supplied by stderr.
  const knownNotRepository = operation === "inspect" && action === "rev-parse" &&
    value.code === 128 && typeof value.stderr === "string" &&
    value.stderr.trim() === "fatal: not a git repository (or any of the parent directories): .git";
  const knownUnresolvedHead = exactHead && operation === "inspect" && action === "rev-parse" &&
    value.code === 128 && typeof value.stderr === "string" && value.stderr.trim() === unresolvedHeadStderr;
  if (knownNotRepository) {
    gitFailures.set(error, `${gitPrefix[operation]} (git ${action}; ${detail}; ${notRepository}). ${notRepositoryGuidance}`);
  } else if (knownUnresolvedHead) {
    gitFailures.set(error, `${gitPrefix[operation]} (git ${action}; ${detail}; ${unresolvedHead}). ${unresolvedHeadGuidance}`);
  } else {
    gitFailures.set(error, `${gitPrefix[operation]} (git ${action}; ${detail}). ${gitGuidance[operation]} ${gitSuffix}`);
  }
}

const sharedFolderFailures: Readonly<Record<string, string>> = {
  ENOENT: "The Shared folder or one of its parent folders could not be found (ENOENT). Restore or reconnect it, then retry.",
  ENOTDIR: "A component of the Shared folder path is not a directory (ENOTDIR). Check the selected folder, then retry.",
  EACCES: "Access was denied while resolving the Shared folder (EACCES). Check the folder and parent directory permissions, then retry.",
  EPERM: "Access was denied while resolving the Shared folder (EPERM). Check the folder and parent directory permissions, then retry.",
};

/** Classify only the host error from resolving the Shared folder. */
export function recordWorkingCopySharedFolderFailure(error: unknown): void {
  if (!error || typeof error !== "object" || !("code" in error)) return;
  const code = (error as {code?: unknown}).code;
  if (typeof code === "string" && Object.hasOwn(sharedFolderFailures, code)) gitFailures.set(error, sharedFolderFailures[code]!);
}

/** Carry only the already-classified diagnostic through host wrappers. */
export function carryWorkingCopyGitFailure(source: unknown, target: object): void {
  if (source && typeof source === "object") {
    const value = gitFailures.get(source);
    if (value) gitFailures.set(target, value);
  }
}

/** Stored forms contain only a closed operation, status and fixed guidance. */
export function isStoredWorkingCopyGitFailure(value: string): boolean {
  if (Object.values(sharedFolderFailures).includes(value)) return true;
  if (value === `${gitPrefix.inspect} (git rev-parse; exit status 128; ${notRepository}). ${notRepositoryGuidance}` ||
      value === `${gitPrefix.inspect} (git rev-parse; exit status 128; ${unresolvedHead}). ${unresolvedHeadGuidance}`) return true;
  for (const op of ["inspect", "update"] as const) {
    const start = `${gitPrefix[op]} (`, end = `). ${gitGuidance[op]} ${gitSuffix}`;
    if (!value.startsWith(start) || !value.endsWith(end)) continue;
    const parts = value.slice(start.length, -end.length).split("; ");
    if (parts.length !== 2 || !parts[0]!.startsWith("git ") || !gitActions.has(parts[0]!.slice(4))) continue;
    const detail = parts[1]!;
    if (detail === "the cause was not identified" || /^stopped by SIG(?:TERM|KILL|INT)$/.test(detail)) return true;
    if (Object.entries(gitSystemCodes).some(([code, text]) => detail === `system error ${code}: ${text}`)) return true;
    const status = /^exit status ([1-9][0-9]{0,2})$/.exec(detail);
    if (status && Number(status[1]) <= 255) return true;
  }
  return false;
}

/** Reconstitute only the closed persisted form on a host-created exception. */
export function adoptStoredWorkingCopyGitFailure(target: object, value: string): void {
  if (isStoredWorkingCopyGitFailure(value)) gitFailures.set(target, value);
}

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
  if (error && typeof error === "object" && gitFailures.has(error)) return gitFailures.get(error)!;
  if (error instanceof Error && fixedReason(error.message)) return error.message;
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(systemCodes, code) ? systemCodes[code]! : generic;
}

export function safeWorkingCopyFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(systemCodes, code) ? code : "ERR_IMPORTED_GIT_ADOPTION_PARTIAL";
}

export function safeStoredWorkingCopy(copy: AgentWorkingCopyDto): AgentWorkingCopyDto {
  return copy.failure === undefined ? copy : { ...copy, failure: fixedReason(copy.failure) || Object.values(systemCodes).includes(copy.failure) || copy.failure === generic || isStoredWorkingCopyGitFailure(copy.failure) ? copy.failure : legacyWithheld };
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
