import type { MessageDto } from '@ponderosa/core';

/** This is a presentation filter over canonical communication, never a second chat log. */
export function pineconeMessages(messages: MessageDto[], spokespersonId: string): MessageDto[] {
  return messages.filter(message => message.communicationIntent !== 'collaboration' && (
    message.role === 'user' && message.communicationIntent === 'user_dm' ||
    message.role === 'assistant' && message.authorAgentId === spokespersonId
  ));
}

export function pineconeDraftKey(branchId: string, spokespersonId: string): string {
  return `ponderosa.pinecone.draft:${branchId}:${spokespersonId}`;
}

/** Merge oldest-to-newest canonical pages; the newest projection owns receipts. */
export function mergePineconeHistory(pages: MessageDto[][]): MessageDto[] {
  const messages = new Map<string, MessageDto>();
  for (const page of pages) for (const message of page) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Bounded status projection; an old unresolved check wins over a newer success. */
export function checkStatus(executions: import('@ponderosa/core').BranchExecutionDto[], enabled: boolean | undefined, now = Date.now()): string {
  const automatic = executions.filter(e => e.admissionSource === 'automatic').sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt));
  if (automatic.some(e => e.state === 'waiting' && now-Date.parse(e.updatedAt) > 30*60*1000) ||
      automatic.length >= 3 && automatic.slice(0,3).every(e => e.state === 'failed')) return 'Check-ins are delayed. Chat still works.';
  if (enabled === false) return 'Check-ins paused';
  if (automatic.some(e => e.state === 'running' || e.state === 'queued')) return 'Checking…';
  const last = automatic.find(e => e.state === 'completed');
  return last ? `Checked ${new Date(last.updatedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}` : 'Check-ins ready';
}

export function safeMessageRetry(receipts: import('@ponderosa/core').MessageDeliveryReceiptDto[] | undefined): boolean {
  return Boolean(receipts?.length && receipts.every(r => r.canRetry && !r.retryMayDuplicate && ['failed','undelivered','retry_exhausted'].includes(r.state)));
}

/** Human copy over canonical receipts; runtime/policy diagnostics stay advanced. */
export function pineconeDeliveryLabel(receipts: import('@ponderosa/core').MessageDeliveryReceiptDto[] | undefined): string | undefined {
  if (!receipts?.length) return undefined;
  const states = receipts.map(r => r.state);
  if (states.some(s => ['run_unconfirmed','unconfirmed','waiting_for_run','recovery_queued','recovering'].includes(s))) return 'Outcome needs review';
  if (states.some(s => ['failed','undelivered','retry_exhausted'].includes(s))) return 'Couldn’t finish';
  if (states.includes('cancelled')) return 'Cancelled';
  if (states.every(s => s === 'processed')) return 'Finished';
  if (states.includes('started')) return 'Working…';
  if (states.includes('delivered')) return 'Received';
  return 'Message saved';
}
