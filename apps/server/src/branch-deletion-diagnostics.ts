import {isMemoryCleanupHold} from './local-memory-authority.js';

// Arbitrary exceptions may contain unlabeled provider credentials. Only
// fixed, locally authored fence messages and known SQLite codes are public.
const BRANCH_DELETION_PUBLIC_BLOCKERS=new Set([
 'Temporary agent copy working files were excluded from final custody; cleanup held',
 'Temporary agent copy final memory is unavailable; cleanup held',
 'Temporary agent copy final context changed repeatedly; cleanup held',
 'Expert copy has an unresolved provider outcome; cleanup held',
 'Original generation deletion requires an exact sealed capture and intake fence receipt',
 'Final resource exit evidence pins owner deletion until archival',
 'Issued tree custody holds owner deletion',
 'Other Branches depend on this Branch',
 'An active execution still depends on this Branch',
 'Cancel/drain and delete Branch-owned Chats before finalizing deletion',
 'Cancel and drain Branch executions before deletion',
 'Branch audit publication is still pending',
 'Branch gate notification closure is still pending',
 'Branch budget audit publication is still pending',
 'Finish Output role recovery before deleting a published Branch tree',
 // Fixed host-authored retirement and ownership reasons remain actionable.
 'Branch Chat cleanup remains pending',
 'Branch Agent cleanup remains pending',
 'Branch Agent owner is unavailable',
 'Branch cleanup would affect an unrelated Agent',
 'Branch cleanup would affect an active or unowned installed Agent',
 'Historical temporary Chat ownership changed',
 'Temporary Chat ownership changed',
 'Provider process cleanup remains pending',
 'Generation custody unavailable',
 'Observed generation runtime/custody service unavailable; cleanup held',
 'Generation exit seal unavailable; cleanup held',
 'Final resource package has no working-folder inventory',
 'Final resource working-folder inventory is incomplete; cleanup held',
 'Final resource checkpoint package service unavailable; cleanup held',
 'Final resource package receipt unavailable; cleanup held',
 'Final resource package predates working-folder capture; cleanup held',
 'Final resource package intent differs; cleanup held',
 'Final resource exit changed during package verification',
 'Observed final resource drain unavailable; cleanup held',
 'Final resource cleanup changed after drain',
 'Final resource cleanup changed after package capture',
 'Required checkpoint custody unavailable',
 'Checkpoint custody was reconciled',
 'Checkpoint custody has been released',
 'Checkpoint custody receipt does not match retained capture',
 'Checkpoint custody bytes unavailable or changed',
 'Checkpoint custody digest mismatch',
 'Checkpoint custody retired during read',
]);
// These exact host-authored final-custody guards carry no external text.
// Limit them to resource cleanup; other errors still use the safe classifier.
const BRANCH_RESOURCE_FINAL_BLOCKERS=new Set([
 'Expert final context custody unavailable; cleanup held',
 'Observed expert provider drain unavailable; cleanup held',
 'Expert final context fence or provider drain changed',
 'Expert final capture receipt unavailable',
 'Expert final context receipt unavailable; cleanup held',
 'Temporary agent copy final custody unavailable',
 'Exact temporary agent copy final custody unavailable',
 'Temporary agent copy final fence is unavailable',
 'Temporary agent copy final fence identity differs',
 'Temporary agent copy final custody bytes changed',
 'Exact completed expert copy ownership required for final capture',
 'Final resource fence evidence changed',
 'Current checkpoint custody unavailable',
 'Current checkpoint custody bytes differ',
 'Checkpoint custody changed',
 'Checkpoint custody grew',
 'Checkpoint custody digest changed',
 'Checkpoint custody released during verification',
]);
// Fixed descriptions explain verified error classes without copying arbitrary
// SQL, paths, trigger messages, or unlabeled credential values.
const BRANCH_DELETION_ERROR_DESCRIPTIONS:Readonly<Record<string,string>>=Object.freeze({
 SQLITE_CONSTRAINT_TRIGGER:'A database trigger rejected the operation.',
 SQLITE_CONSTRAINT_FOREIGNKEY:'A related database record prevented the operation.',
 SQLITE_CONSTRAINT_NOTNULL:'A required database value was missing.',
 SQLITE_CONSTRAINT_UNIQUE:'A database uniqueness constraint was violated.',
 SQLITE_CONSTRAINT_PRIMARYKEY:'A database primary-key constraint was violated.',
 SQLITE_CONSTRAINT_CHECK:'A database check constraint was violated.',
 SQLITE_BUSY:'The database was busy.',
 SQLITE_LOCKED:'The database or table was locked.',
 SQLITE_FULL:'The database could not write because storage was full.',
 SQLITE_READONLY:'The database was read-only.',
 SQLITE_IOERR:'The database reported an input/output error.',
 SQLITE_CORRUPT:'The database reported corruption.',
 SQLITE_CANTOPEN:'The database could not open a required file.',
 EACCES:'The operating system denied access.',
 EPERM:'The operating system denied the operation.',
 ENOSPC:'The operating system reported no space left.',
 EROFS:'The operating system reported a read-only filesystem.',
});
const BRANCH_DELETION_STEPS={
 pending:'checking pending installation',
 receipts:'compacting installation receipts',
 notifications:'settling notifications',
 records:'removing Workflow records',
 agent:'removing a Workflow Agent',
 chat:'removing a Workflow Chat',
 historical:'removing a historical Workflow Chat',
 resource:'cleaning up a temporary Workflow resource',
} as const;
export type BranchDeletionStep=keyof typeof BRANCH_DELETION_STEPS;
function safeFailureCode(error:unknown):unknown {
 const cause=error instanceof Error?error.cause:undefined;
 return (typeof error==='object'&&error!==null&&'code' in error)?(error as {code?:unknown}).code:
  (typeof cause==='object'&&cause!==null&&'code' in cause)?(cause as {code?:unknown}).code:undefined;
}
function safeFailureDescription(code:unknown):string|undefined {
 return typeof code==='string'&&Object.hasOwn(BRANCH_DELETION_ERROR_DESCRIPTIONS,code)?BRANCH_DELETION_ERROR_DESCRIPTIONS[code]:undefined;
}
/** Keep the structured cause while withholding arbitrary preflight text. */
export function describeExpertMemoryPreflightFailure(error:unknown):string {
 const code=safeFailureCode(error),description=safeFailureDescription(code);
 return description
  ? `Expert memory preflight failed (${code}): ${description} Details withheld because they may contain credentials.`
  : 'Expert memory preflight failed. Details withheld because they may contain credentials.';
}
/** Do not copy arbitrary exception text into the direct Chat response. */
export function describeChatDeletionIntentFailure(error:unknown):string {
 const message=error instanceof Error?error.message:'';
 if(BRANCH_DELETION_PUBLIC_BLOCKERS.has(message)||isMemoryCleanupHold(message)||message==='Chat deletion intent could not be persisted'||message==='conversation not found')return message;
 const code=safeFailureCode(error),description=safeFailureDescription(code);
 return description
  ? `Chat deletion intent could not be confirmed (${code}): ${description} Details withheld because they may contain credentials.`
  : 'Chat deletion intent could not be confirmed. Details withheld because they may contain credentials.';
}
export function describeBranchDeletionFailure(error:unknown,step?:BranchDeletionStep):string{
 const message=error instanceof Error?error.message:'';
 if(BRANCH_DELETION_PUBLIC_BLOCKERS.has(message)||isMemoryCleanupHold(message))return message;
 const code=safeFailureCode(error),description=safeFailureDescription(code);
 if(step==='resource'&&code===undefined&&BRANCH_RESOURCE_FINAL_BLOCKERS.has(message))return `${message}. Cleanup step: ${BRANCH_DELETION_STEPS.resource}.`;
 // This exact host-authored guard identifies an audit-record integrity failure.
 // Match the entire fixed message only at its actual deletion step; never
 // publish the saved journal, arbitrary exception text, or trigger details.
 const groupScopeMismatch=step==='records'&&code===undefined&&message==='Retained group journal original scope differs';
 // This fixed host-authored guard is reached from the deletion fence before
 // owner records change. Never include arbitrary exception text or receipts.
 const finalExitUnavailable=(step===undefined||step==='records')&&code===undefined&&
  message==='Authentic final resource exit command unavailable or ambiguous';
 const safe=finalExitUnavailable
  ? 'Workflow deletion is blocked because its final resource exit record is missing or ambiguous. Keep the Workflow and its data while the exit record is reviewed.'
  : groupScopeMismatch
  ? 'Workflow cleanup failed: retained group audit evidence does not match its Workflow and execution. Workflow records were preserved.'
  : description
  ? `Workflow cleanup failed (${code}): ${description} Details withheld because they may contain credentials.`
  : 'Workflow cleanup failed. Details withheld because they may contain credentials.';
 const label=step&&Object.hasOwn(BRANCH_DELETION_STEPS,step)?BRANCH_DELETION_STEPS[step]:undefined;
 return label?`${safe} Cleanup step: ${label}.`:safe;
}
