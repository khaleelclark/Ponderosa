import type Database from "better-sqlite3";

/** A workflow may cancel while guidance is being prepared. Check its exact
 * durable owner immediately before provider submission, not when leased. */
export function requireBranchGuidanceSubmission(sqlite:Database.Database,injectionId:string,runId:string):void {
 const owns=sqlite.prepare(`SELECT 1 FROM scheduler_prompt_injections injection,json_each(injection.activation_ids_json) member
   JOIN activation_sources source ON source.activation_id=member.value AND source.source_kind='branch_guidance'
   WHERE injection.id=? AND injection.run_id=? LIMIT 1`).get(injectionId,runId);
 if(!owns)return;
 const invalid=sqlite.prepare(`SELECT 1 FROM scheduler_prompt_injections injection,json_each(injection.activation_ids_json) member
   JOIN activation_sources source ON source.activation_id=member.value AND source.source_kind=?
   JOIN agent_activations activation ON activation.id=source.activation_id
   LEFT JOIN branch_attempts attempt ON attempt.id=source.source_id
   LEFT JOIN branch_step_executions step ON step.id=attempt.step_execution_id
   LEFT JOIN branch_executions execution ON execution.id=step.execution_id
   LEFT JOIN scheduler_runs run ON run.id=injection.run_id
   WHERE injection.id=? AND injection.run_id=? AND NOT COALESCE((
     attempt.state=? AND attempt.cancel_requested=0 AND execution.cancel_requested=0
     AND execution.state IN (?,?) AND run.agent_id=activation.agent_id
     AND run.project_id=activation.project_id AND run.scope_key=activation.scope_key
     AND EXISTS(SELECT 1 FROM scheduler_run_activations attached
       WHERE attached.run_id=run.id AND attached.activation_id=activation.id)),0)
   LIMIT 1`).get("branch_guidance",injectionId,runId,"waiting","running","waiting");
 if(invalid)throw new Error("Workflow guidance is no longer authorized for submission");
}
