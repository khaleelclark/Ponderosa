import type { BranchDefinition } from '@ponderosa/core';

/** Conservative count for one successful, non-loop traversal. Unknown routes only warn. */
export function branchTraversalPreflight(definition: BranchDefinition): { minimum: number; uncertain: boolean } {
  const nodes = new Map([...definition.steps, ...definition.controls].map(node => [node.id, node]));
  const memo = new Map<string, { minimum: number; uncertain: boolean }>();
  const walk = (id: string, stopAt: string | undefined, visiting: Set<string>): { minimum: number; uncertain: boolean } => {
    if (visiting.has(id)) return { minimum: 0, uncertain: true };
    const key=`${id}\u0000${stopAt??''}`;
    const saved=memo.get(key);if(saved)return saved;
    const node = nodes.get(id);
    if (!node) return { minimum: 0, uncertain: true };
    if (id === stopAt) return { minimum: 1, uncertain: false }; // each arriving fork path charges its join
    const nextVisiting = new Set(visiting).add(id);
    const outgoing = definition.edges.filter(edge => edge.from === id);
    const nonStopFailure='failure' in node && (node.failure??definition.policy.failure).action!=='stop';
    let result: { minimum: number; uncertain: boolean };
    if (node.kind === 'fork') {
      const join = nodes.get(node.joinId);
      const arms = outgoing.map(edge => edge.loop ? { minimum: 0, uncertain: true } : walk(edge.to, node.joinId, nextVisiting));
      const joinEdges=definition.edges.filter(edge => edge.from === node.joinId);
      const continuation = joinEdges.find(edge => edge.on === 'success');
      const rest = continuation ? walk(continuation.to, stopAt, nextVisiting) : { minimum: 0, uncertain: false };
      result = { minimum: 1 + arms.reduce((sum, arm) => sum + arm.minimum, 0) + rest.minimum,
        uncertain: join?.kind !== 'join' || join.mode !== 'all' || joinEdges.some(edge => edge.on !== 'success') || arms.some(arm => arm.uncertain) || rest.uncertain || outgoing.some(edge => edge.loop) };
    } else if (node.kind === 'map') {
      const joinEdges=definition.edges.filter(edge=>edge.from===node.joinId);
      const continuation=joinEdges.find(edge=>edge.on==='success');
      const rest=continuation?walk(continuation.to,stopAt,nextVisiting):{minimum:0,uncertain:false};
      result={minimum:1+rest.minimum,uncertain:true}; // cardinality is sealed only at admission
    } else if (node.kind === 'condition' || node.kind === 'route') {
      const routes = outgoing.map(edge => edge.loop ? { minimum: 0, uncertain: true } : walk(edge.to, stopAt, nextVisiting));
      result = { minimum: 1 + Math.min(...routes.map(route => route.minimum)), uncertain: true };
    } else {
      const normal = outgoing.find(edge => edge.on === (node.kind === 'human_gate' ? 'approved' : 'success'));
      if (!normal) result = { minimum: 1, uncertain: outgoing.length>0 || nonStopFailure || node.kind==='human_gate' };
      else if (normal.loop) result = { minimum: 1, uncertain: true };
      else {
        const tail = walk(normal.to, stopAt, nextVisiting);
        result = { minimum: 1 + tail.minimum, uncertain: tail.uncertain || nonStopFailure || node.kind==='human_gate' || outgoing.some(edge => edge.on !== normal.on) };
      }
    }
    memo.set(key,result);return result;
  };
  return walk(definition.entry, undefined, new Set());
}
