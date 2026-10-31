import { validateBranchTemplate } from "./branch-template.js";
import { BranchValidationError, type BranchValidationIssue, normalizeCanonicalText, INLINE_TEXT_MAX_CODE_POINTS, unicodeCodePointLength, type BranchBindings, type BranchDefinition } from "@ponderosa/core";
import { stableJson } from "./coordination-v3-canonical-json.js";

export function branchText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Branch text must be a string");
  const text = normalizeCanonicalText(value);
  // ponytail: inline-only first slice; large text uses explicit managed artifact refs.
  if (unicodeCodePointLength(text) > INLINE_TEXT_MAX_CODE_POINTS) throw new Error("Branch text exceeds inline limit; use a managed artifact reference");
  return text;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected Branch object");
  return value as Record<string, unknown>;
}
function keys(value: unknown, allowed: string[]): Record<string, unknown> {
  const object = record(value);
  const unsupported=Object.keys(object).filter(key=>!allowed.includes(key));
  if (unsupported.length) throw new Error(`Unsupported field ${unsupported.map(k=>JSON.stringify(k)).join(", ")}. Valid fields: ${allowed.join(", ")}.`);
  return object;
}
export function branchKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/u.test(value)) throw new Error("Invalid Branch identity/ref");
  return value;
}
function boundedInteger(value: unknown, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
}
function failurePolicy(value: unknown): void {
  let field = "failure";
  try {
  const p = record(value);
  if (p.action === "stop" || p.action === "ask_human") keys(p, ["action"]);
  else if (p.action === "retry") {
    keys(p, ["action", "maxAttempts", "delayMs", "freshContext"]);
    if (p.freshContext !== undefined && typeof p.freshContext !== "boolean") throw new Error("Invalid fresh retry policy");
    field = "failure.maxAttempts"; boundedInteger(p.maxAttempts, 1, 100, "retry attempts"); field = "failure.delayMs"; boundedInteger(p.delayMs, 0, 86_400_000, "retry delay");
  } else if (p.action === "recover") {
    keys(p, ["action", "agentRef", "maxAttempts"]); field = "failure.agentRef"; branchKey(p.agentRef); field = "failure.maxAttempts"; boundedInteger(p.maxAttempts, 1, 100, "recovery attempts");
  } else throw new Error("Invalid failure policy");
  } catch (error) { throw new BranchValidationError((error as Error).message, { section: "failure", field }); }
}
/** Validate a structured graph with explicit loop edges; fork instances pair with exact joins. */
export function validateBranchDefinition(value: unknown): BranchDefinition {
  try { return validateDefinition(value); }
  catch(error) { const name=value && typeof value==='object' && 'name' in value && typeof value.name==='string' ? value.name.slice(0,240) : 'Untitled'; throw new BranchValidationError(`Branch "${name}": ${error instanceof Error?error.message:'Invalid definition.'}`, error instanceof BranchValidationError ? error.issue : { section: 'workflow' }); }
}
function validateDefinition(value: unknown): BranchDefinition {
  const serialized = stableJson(value, { maxDepth: 32, maxNodes: 10_000 });
  if (Buffer.byteLength(serialized) > 512_000) throw new Error("Branch definition too large");
  const d = keys(JSON.parse(serialized), ["schema", "name", "trigger", "parameters", "templates", "entry", "steps", "controls", "edges", "policy"]);
  if (d.schema !== "ponderosa.branch.v1") throw new Error("Unsupported Branch schema");
  d.name = branchText(d.name);
  if (!d.name || String(d.name).length > 240) throw new Error("Invalid Branch name");
  const trigger = record(d.trigger);
  if (trigger.kind === "manual") keys(trigger, ["kind"]);
  else { keys(trigger, ["kind", "configRef"]); if (!["schedule", "webhook", "filesystem"].includes(String(trigger.kind))) throw new Error("Invalid Branch trigger"); branchKey(trigger.configRef); }
  if (d.parameters !== undefined) for (const [name,raw] of Object.entries(record(d.parameters))) {
    branchKey(name); const p=keys(raw,['type','label','help','required','default']);
    if (!['text','number','boolean','path','secret'].includes(String(p.type))) throw new Error('Invalid parameter type');
    if (p.label !== undefined) p.label=branchText(p.label);
    if (p.help !== undefined) p.help=branchText(p.help);
    if (p.required !== undefined && typeof p.required !== 'boolean') throw new Error('Invalid parameter requirement');
    if (p.type === 'secret' && p.default !== undefined) throw new Error('Secret defaults are forbidden');
    if (p.default !== undefined && ((p.type === 'text'||p.type==='path') ? typeof p.default !== 'string' : p.type==='number' ? typeof p.default !== 'number'||!Number.isFinite(p.default) : typeof p.default !== 'boolean')) throw new Error('Invalid parameter default');
  }
  if (d.templates !== undefined) for (const [ref, template] of Object.entries(record(d.templates))) {
    try { branchKey(ref); validateBranchTemplate(template); }
    catch (error) { const step = Array.isArray(d.steps) ? d.steps.find(raw => raw && typeof raw === 'object' && raw.kind === 'agent' && raw.target?.templateRef === ref) : undefined; throw new BranchValidationError((error as Error).message, {section:'agent_setup',field:'templates',...(error instanceof BranchValidationError?error.issue:{}),...(step?{nodeId:String(step.id)}:{})}); }
  }
  const policy = keys(d.policy, ["maxConcurrentExecutions", "maxPathInstances", "maxStepInvocations", "maxEphemeralAgents", "failure"]);
  boundedInteger(policy.maxConcurrentExecutions, 1, 1000, "Branch concurrency");
  try { failurePolicy(policy.failure); } catch (error) { throw new BranchValidationError((error as Error).message, { ...(error instanceof BranchValidationError ? error.issue : {}), section: 'settings' }); }
  for (const key of ["maxPathInstances", "maxStepInvocations", "maxEphemeralAgents"]) if (policy[key] !== undefined) boundedInteger(policy[key], 1, 100_000, key);
  if (!Array.isArray(d.steps) || !d.steps.length || d.steps.length > 100) throw new Error("Branch requires 1–100 steps");
  if (!Array.isArray(d.controls) || d.controls.length > 100) throw new Error("Invalid control nodes");
  const nodes = new Map<string, Record<string, unknown>>();
  for (const raw of [...d.steps, ...d.controls]) {
    const node = record(raw), id = branchKey(node.id);
    if (node.label !== undefined) { node.label = branchText(node.label); if (String(node.label).length>240) throw new Error("Node label is too long"); }
    if (nodes.has(id)) throw new Error("Duplicate node ID"); nodes.set(id, node);
  }
  for (const raw of d.steps) {
    const step = record(raw);
    let section: BranchValidationIssue["section"] = "task", field: string | undefined;
    try {
    if (step.failure !== undefined) failurePolicy(step.failure);
    if (step.kind === "agent") {
      keys(step, ["id", "label", "kind", "target", "instructions", "failure", "requireUserCommunication"]);
      if(step.requireUserCommunication!==undefined&&typeof step.requireUserCommunication!=='boolean')throw Error('requireUserCommunication must be boolean');
      field = "target"; const target = record(step.target);
      if (target.kind === "persistent_agent" || target.kind === "persistent_organization") { keys(target, ["kind", "ref"]); branchKey(target.ref); }
      else if (target.kind === "ephemeral_agent" || target.kind === "ephemeral_organization") {
        keys(target, ["kind", "templateRef"]); branchKey(target.templateRef);
        const template = record(d.templates)[String(target.templateRef)];
        if (!template || validateBranchTemplate(template).kind !== (target.kind === "ephemeral_agent" ? "agent" : "organization")) throw new Error("Missing or incompatible Agent template");
      } else throw new Error("Invalid Agent target");
      field = "instructions"; step.instructions = branchText(step.instructions);
    } else if (step.kind === "branch_call") {
      keys(step,['id','label','kind','branchRef','canceled','failure']); field = 'branchRef'; branchKey(step.branchRef);
      if (step.canceled !== undefined && !['retry','ask_human','terminate'].includes(String(step.canceled))) throw new Error('Invalid canceled child policy');
    } else if (step.kind === "script") {
      keys(step, ["id", "label", "kind", "runtime", "source", "cwdRef", "timeoutMs", "failure"]);
      if (step.runtime !== "node") throw new Error("Unsupported Script runtime");
      field = "source"; if (typeof step.source !== "string" || Buffer.byteLength(step.source) > 256_000) throw new Error("Invalid Script source");
      section = "advanced"; field = "cwdRef"; branchKey(step.cwdRef); field = "timeoutMs"; boundedInteger(step.timeoutMs, 1, 3_600_000, "Script timeout");
    } else if (step.kind === "human_gate") {
      keys(step, ["id", "label", "kind", "prompt", "editable", "choices", "failure"]);
      field = "prompt"; step.prompt = branchText(step.prompt);
      if (typeof step.editable !== "boolean") throw new Error("Gate editable must be boolean");
      if (step.choices !== undefined && (!Array.isArray(step.choices) || !step.choices.length || step.choices.length > 30 || new Set(step.choices).size !== step.choices.length)) throw new Error("Invalid gate choices");
      if (Array.isArray(step.choices)) step.choices = step.choices.map(branchText);
    } else if (step.kind === "action") {
      keys(step,["id","label","kind","action","configRefs","failure"]);
      if(step.action!=="notify" || !Array.isArray(step.configRefs) || step.configRefs.length!==0)throw new Error("Supported Action: notify, with no external configuration");
    } else throw new Error(`Step kind is invalid. Choose Agent, Script, human gate, Branch Call or notify.`);
    } catch(error) { throw new BranchValidationError(`Step "${step.label??step.id}": ${(error as Error).message}`, { nodeId: String(step.id), section, field, ...(error instanceof BranchValidationError ? error.issue : {}) }); }
  }
  for (const raw of d.controls) {
    const c = record(raw);
    try {
    if (c.kind === "condition") {
      keys(c, ["id", "label", "kind", "predicate", "otherwise"]);
      const predicate = keys(c.predicate, ["source", "equals"]);
      if (predicate.source !== "input") throw new Error("Conditions read their explicit input; use a Script to transform it");
      predicate.equals = branchText(predicate.equals); branchKey(c.otherwise);
    } else if (c.kind === "route") {
      keys(c, ["id", "label", "kind", "otherwise"]); branchKey(c.otherwise);
    } else if (c.kind === "fork") { keys(c, ["id", "label", "kind", "joinId"]); branchKey(c.joinId); }
    else if (c.kind === "map") {
      keys(c, ["id", "label", "kind", "joinId", "workerId", "source", "maxItems", "maxConcurrentItems"]);
      branchKey(c.joinId); branchKey(c.workerId);
      if (!["interpret", "list", "lines"].includes(String(c.source))) throw new Error("Map source must be interpret, list or lines");
      boundedInteger(c.maxItems, 1, 100_000, "Map maxItems");
      boundedInteger(c.maxConcurrentItems, 1, 1000, "Map concurrency");
      if (Number(c.maxConcurrentItems) > Number(c.maxItems)) throw new Error("Map concurrency cannot exceed maxItems");
    }
    else if (c.kind === "join") {
      keys(c, ["id", "label", "kind", "forkId", "mode", "quorum", "remainder", "inputOrder", "onUnmet"]); branchKey(c.forkId);
      if (!["all", "any", "quorum"].includes(String(c.mode)) || !["finish", "cancel"].includes(String(c.remainder))) throw new Error("Invalid join policy");
      if (c.onUnmet !== undefined && !["fail", "continue"].includes(String(c.onUnmet))) throw new Error("Invalid Join failure policy");
      if (!Array.isArray(c.inputOrder) || new Set(c.inputOrder).size !== c.inputOrder.length) throw new Error("Invalid join input order");
      c.inputOrder.forEach(branchKey);
      if (c.mode === "quorum") boundedInteger(c.quorum, 1, 100_000, "join quorum");
      else if (c.quorum !== undefined) throw new Error("Quorum belongs only to quorum joins");
    } else throw new Error("Control kind must be condition, route, fork, Map or Join.");
    } catch(error) { throw new BranchValidationError(`Control "${c.label??c.id}": ${(error as Error).message}`, { nodeId: String(c.id), section: "task" }); }
  }
  if (!Array.isArray(d.edges) || d.edges.length > 500) throw new Error("Invalid graph edges");
  const edges = d.edges.map(raw => keys(raw, ["id", "from", "to", "on", "choice", "loop", "input"]));
  const edgeIds = new Set<string>();
  for (const e of edges) {
    let field = "to";
    try {
    const id = branchKey(e.id), from = branchKey(e.from), to = branchKey(e.to);
    if (edgeIds.has(id) || !nodes.has(from) || !nodes.has(to)) throw new Error("Invalid graph edge");
    edgeIds.add(id);
    field = 'loop'; if (e.loop !== undefined && typeof e.loop !== 'boolean') throw new Error('Invalid loop edge');
    field = 'input'; if(e.input !== undefined) { const input=keys(e.input,['kind','text']); if(input.kind === 'literal') branchText(input.text); else if(input.kind !== 'output'||input.text !== undefined) throw new Error('Invalid edge input'); }
    field = "choice"; if (e.choice !== undefined) { e.choice = branchText(e.choice).trim(); if (!e.choice || String(e.choice).length > 100) throw new Error('Invalid route choice'); }
    field = "on"; if (!["success", "failure", "approved", "rejected", "selected", "canceled"].includes(String(e.on))) throw new Error("Invalid edge outcome");
    } catch (error) { throw new BranchValidationError((error as Error).message, { nodeId: String(e.from), edgeId: String(e.id), section: field === "input" || field === "loop" ? "advanced" : "connections", field }); }
  }
  for (const [id, node] of nodes) {
    const outgoing = edges.filter(e => e.from === id);
    try {
    if (node.kind !== "fork" && node.kind !== "route" && node.kind !== "map" && new Set(outgoing.map(e => e.on)).size !== outgoing.length) throw new Error("Ambiguous outgoing edges");
    const allowed = node.kind === "condition" || node.kind === "route" ? ["selected", "failure"] : node.kind === "fork" || node.kind === "map" ? ["selected"] : node.kind === "human_gate" ? ["approved", "rejected"] : node.kind === "branch_call" ? ["success", "failure", "canceled"] : ["success", "failure"];
    if (outgoing.some(e => !allowed.includes(String(e.on)))) throw new Error("Edge outcome does not match node kind");
    if (node.kind !== "route" && outgoing.some(e => e.choice !== undefined)) throw new Error("Choices belong only to Route edges");
    if (node.kind === "condition" && (outgoing.length !== 2 || !outgoing.some(e => e.on === "selected") || !outgoing.some(e => e.on === "failure" && e.to === node.otherwise))) throw new Error("Condition requires selected and otherwise edges");
    if (node.kind === "route") {
      const selected = outgoing.filter(e => e.on === "selected");
      if (!selected.length || outgoing.filter(e => e.on === "failure").length !== 1 || !outgoing.some(e => e.on === "failure" && e.to === node.otherwise)) throw new Error("Route requires choices and one otherwise edge");
      if (selected.some(e => !e.choice) || new Set(selected.map(e => String(e.choice).toLowerCase())).size !== selected.length || outgoing.some(e => e.on === "failure" && e.choice !== undefined)) throw new Error("Route choices must be distinct and nonempty");
    }
    if (node.kind === "fork") {
      const join = nodes.get(String(node.joinId));
      if (!join || join.kind !== "join" || join.forkId !== id || outgoing.length < 2) throw new Error("Fork requires a paired join and at least two paths");
      const order = join.inputOrder as string[];
      if (order.length !== outgoing.length || outgoing.some(e => !order.includes(String(e.id)))) throw new Error("Join input order must name every fork edge exactly once");
      if (join.mode === "quorum" && Number(join.quorum) > outgoing.length) throw new Error("Impossible join quorum");
    }
    if (node.kind === "map") {
      const join = nodes.get(String(node.joinId));
      const worker = nodes.get(String(node.workerId));
      if (!join || join.kind !== "join" || join.forkId !== id || !worker || !d.steps.includes(worker)) throw new Error("Map requires one worker Step and a paired Join");
      if (outgoing.length !== 1 || outgoing[0]?.to !== node.workerId || outgoing[0]?.on !== "selected") throw new Error("Map requires one selected edge to its worker");
      const workerEdges = edges.filter(e => e.from === node.workerId);
      if (workerEdges.length !== 1 || workerEdges[0]?.to !== node.joinId || workerEdges[0]?.on !== "success") throw new Error("Map worker must connect directly to its Join on success");
      if ((join.inputOrder as unknown[]).length) throw new Error("Map Join uses item order, not static inputOrder");
    }
    if (node.kind === "join" && (!["fork", "map"].includes(String(nodes.get(String(node.forkId))?.kind)) || nodes.get(String(node.forkId))?.joinId !== id)) throw new Error("Join requires its paired Fork or Map");
    } catch(error) { throw new BranchValidationError(`Node "${node.label??id}": ${(error as Error).message}`, { nodeId: id, section: "connections" }); }
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const acyclic = (id: string): void => {
    if (visiting.has(id)) throw new Error("Cycles require an explicit loop edge");
    if (visited.has(id)) return;
    if (!nodes.has(id)) throw new Error("Invalid entry");
    visiting.add(id); for (const e of edges.filter(e => e.from === id && !e.loop)) acyclic(String(e.to));
    visiting.delete(id); visited.add(id);
  };
  acyclic(branchKey(d.entry));
  if (visited.size !== nodes.size) throw new Error("Unreachable node without loop entry");
  // A paired join must close the innermost fork on every structural route.
  const contexts = new Set<string>();
  const stacks = new Map<string,string>();
  const structured = (id: string, stack: string[]): void => {
    const existingStack=stacks.get(id); if(existingStack !== undefined && existingStack !== JSON.stringify(stack)) throw new Error("Loop cannot enter another fork context"); stacks.set(id,JSON.stringify(stack));
    const key = JSON.stringify([id, stack]); if (contexts.has(key)) return; contexts.add(key);
    if (contexts.size > 5000) throw new Error("Graph has too many path contexts");
    const node = nodes.get(id)!;
    let next = stack;
    if (node.kind === "fork" || node.kind === "map") next = [...stack, id];
    if (node.kind === "join") {
      if (stack.at(-1) !== node.forkId) throw new Error("Join must close the current fork");
      next = stack.slice(0, -1);
    }
    const outgoing = edges.filter(e => e.from === id);
    if (!outgoing.length && next.length) throw new Error("Fork path must reach its paired join");
    for (const e of outgoing) structured(String(e.to), next);
  };
  structured(String(d.entry), []);
  return d as unknown as BranchDefinition;
}
export function validateBranchBindings(value: unknown, definition?: BranchDefinition): BranchBindings {
  const b = keys(value, ["agents", "directories", "triggers", "engines", "branches"]);
  if (b.triggers !== undefined) for (const [ref, raw] of Object.entries(record(b.triggers))) {
    branchKey(ref); const config = keys(raw, ["sourceConfig", "enabled"]);
    record(config.sourceConfig); if (typeof config.enabled !== "boolean") throw new Error("Trigger enabled must be boolean");
  }
  for (const category of ['agents','directories','engines','branches'] as const) {
    const map=record(b[category]??{});
    for (const [key,value] of Object.entries(map)) {
      branchKey(key);
      if (typeof value !== 'string' || !value.trim() || value.length>4096) {
        const step=definition?.steps.find(s=>category==='directories'?s.kind==='script'&&s.cwdRef===key:category==='branches'?s.kind==='branch_call'&&s.branchRef===key:category==='engines'?s.kind==='agent'&&'templateRef'in s.target&&definition.templates?.[s.target.templateRef]?.agents.some(agent=>agent.engine===key):s.kind==='agent'&&'ref' in s.target&&s.target.ref===key);
        const recovery=category==='agents'?definition?.steps.find(step=>step.failure?.action==='recover'&&step.failure.agentRef===key):undefined;
        const defaultRecovery=category==='agents'&&definition?.policy.failure.action==='recover'&&definition.policy.failure.agentRef===key;
        const where=step?`Step "${step.label??step.id}"`: `Binding "${key}"`;
        const expected=category==='directories'?'Working directory is required. Choose an existing directory, or use "." for the Engine’s current working directory.':category==='agents'?'Agent is required. Choose a persistent Agent in this Branch.':category==='branches'?'Called Branch is required. Choose the workflow to invoke.':'Engine is required. Choose an available subscription-backed Engine.';
        throw new BranchValidationError(`${definition?`Branch "${definition.name}": `:''}${where}: ${typeof value==='string'&&value.length>4096?'Value exceeds 4096 characters.':expected}`, { ...(step||recovery ? { nodeId: (step??recovery)!.id } : {}), section: category === 'directories' ? 'advanced' : category === 'engines' ? 'agent_setup' : !step&&recovery ? 'failure' : !step&&defaultRecovery ? 'settings' : 'task', field: category === 'directories' ? 'cwdRef' : category === 'agents' ? !step&&(recovery||defaultRecovery) ? 'failure.agentRef' : 'target' : category === 'branches' ? 'branchRef' : 'engine' });
      }
    }
  }
  return JSON.parse(stableJson(b)) as BranchBindings;
}
