/** Exact queued work can be resumed after pre-injection failures only if
 * every historical attachment belongs to a terminal unstarted Run. This
 * contains the scheduler's canRetryUninjectedRun checks and additionally
 * rejects contradictory submission evidence and cross-scope Run bindings. */
export function transitionUnsubmittedActivationSql(activation:string):string {
  return `((${activation}.state='pending' AND NOT EXISTS (
      SELECT 1 FROM scheduler_run_activations attached WHERE attached.activation_id=${activation}.id))
    OR (${activation}.state='retry_pending'
      AND EXISTS (SELECT 1 FROM scheduler_run_activations attached WHERE attached.activation_id=${activation}.id)
      AND NOT EXISTS (
        SELECT 1 FROM scheduler_run_activations attached
        LEFT JOIN scheduler_runs run ON run.id=attached.run_id
        WHERE attached.activation_id=${activation}.id AND (
          run.id IS NULL OR run.project_id<>${activation}.project_id OR run.agent_id<>${activation}.agent_id
          OR run.scope_key<>${activation}.scope_key OR run.status NOT IN ('failed','cancelled')
          OR run.terminal_at IS NULL OR attached.consumed_at IS NOT NULL
          OR run.prompt_injection_state<>'not_injected' OR run.started_at IS NOT NULL
          OR EXISTS(SELECT 1 FROM provider_inputs input WHERE input.scheduler_run_id=run.id OR input.execution_id=run.id)
          OR EXISTS(SELECT 1 FROM scheduler_prompt_injections injection WHERE injection.run_id=run.id
            AND (injection.state NOT IN ('pending','cancelled') OR injection.submitted_at IS NOT NULL
              OR injection.acknowledged_at IS NOT NULL OR injection.provider_turn_id IS NOT NULL))
        )
      )))`;
}
