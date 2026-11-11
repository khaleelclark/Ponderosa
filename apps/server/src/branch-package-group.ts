import type {BranchPackageChat} from '@ponderosa/core';
import type {BranchPackageEngine} from './routes/agent-packages.js';

/** Keep Branch topology explicit; the shared engine owns all data remapping. */
export async function composeBranchChat(chat:BranchPackageChat,engine:BranchPackageEngine) {
 return (await engine.composeAgents(chat.agents.map(entry=>({ref:entry.ref,managerRef:entry.managerRef,package:entry.definition})))).package;
}
