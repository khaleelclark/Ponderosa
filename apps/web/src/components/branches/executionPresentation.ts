import type { BranchAttemptDto, BranchExecutionDetailDto, BranchMapItemDto, BranchOperationalSummaryDto } from '@ponderosa/core';

/** Keep the operations projection fresh until it has observed the terminal execution. */
export function shouldPollOperations(executionState: string, summary?: BranchOperationalSummaryDto): boolean {
  return !['completed', 'failed', 'canceled', 'skipped', 'merged'].includes(executionState) || summary?.state !== executionState;
}

/** A joined path is stored as "arrived" even when its worker failed. */
export function mapItemStatus(item: BranchMapItemDto, attempts: readonly Pick<BranchAttemptDto, 'number' | 'state' | 'result'>[] = []): string {
  if (item.result?.failed) return 'failed';
  const last = [...attempts].sort((a, b) => a.number - b.number).at(-1);
  if (last?.state === 'failed' || last?.result?.failed) return 'failed';
  if (last?.state === 'outcome_unknown') return 'outcome_unknown';
  if (item.state === 'arrived') return item.result?.failed === false || last?.result?.failed === false ? 'completed' : 'joined · result unavailable';
  return last?.state ?? item.state;
}

/** Control nodes have checkpoints and Map records, not Step executions. */
export function controlStates(detail: BranchExecutionDetailDto): Record<string, string> {
  const states: Record<string, string> = {};
  for (const decision of [...(detail.decisions ?? [])].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id, undefined, { numeric: true }))) {
    if (!decision.nodeId) continue;
    const state = ({
      condition_selected: 'selected', route_selected: 'routed', route_invalid: 'otherwise',
      fork_started: 'started', map_items_sealed: 'items sealed',
      join_resolved: decision.failed ? 'failed' : 'completed',
      limit_exhausted: 'limit reached',
    } as Record<string, string>)[decision.kind];
    if (state) states[decision.nodeId] = state;
  }
  const mapsByControl = new Map<string, NonNullable<BranchExecutionDetailDto['maps']>>();
  for (const map of detail.maps ?? []) mapsByControl.set(map.mapId, [...(mapsByControl.get(map.mapId) ?? []), map]);
  for (const [mapId, maps] of mapsByControl) {
    const count = maps.reduce((total, map) => total + map.itemCount, 0);
    states[mapId] = maps.some(map => map.state === 'open') ? `${count} item${count === 1 ? '' : 's'} running`
      : maps.some(map => map.state === 'canceled') ? 'canceled'
        : `${count} item${count === 1 ? '' : 's'} settled`;
  }
  for (const wait of detail.waits ?? []) {
    if (wait.kind === 'join' && wait.stepId && !states[wait.stepId]) states[wait.stepId] = 'waiting';
  }
  return states;
}
