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
      ))
    OR (${activation}.state='retry_pending' AND ${activation}.dispatch_policy='next_run'
      AND ${activation}.steering_wait_reason='provider_unsupported'
      AND (${activation}.kind IN ('coordination_request','ordinary_message')
        OR (${activation}.kind='urgent_message' AND ${activation}.prompt_class<>'human'))
      AND NOT EXISTS (SELECT 1 FROM scheduler_run_activations attached WHERE attached.activation_id=${activation}.id)
      -- The unsupported result is a definite no-write refusal. Its cancelled
      -- steer remains exact audit evidence after the old attachment is removed.
      AND EXISTS (
        SELECT 1 FROM scheduler_prompt_injections refused
        JOIN scheduler_runs source ON source.id=refused.run_id, json_each(refused.activation_ids_json) member
        WHERE member.value=${activation}.id AND refused.kind='steer' AND refused.state='cancelled'
          AND refused.submitted_at IS NOT NULL AND refused.terminal_at IS NOT NULL
          AND refused.acknowledged_at IS NULL AND refused.provider_turn_id IS NULL
          AND source.project_id=${activation}.project_id AND source.agent_id=${activation}.agent_id
          AND source.scope_key=${activation}.scope_key AND source.status='completed'
          AND source.terminal_at IS NOT NULL AND source.prompt_injection_state='injected'
          AND NOT EXISTS (
            SELECT 1 FROM scheduler_prompt_injections prior, json_each(prior.activation_ids_json) prior_member
            WHERE prior_member.value=${activation}.id AND prior.id<>refused.id
              AND (prior.state<>'cancelled' OR prior.submitted_at IS NOT NULL
                OR prior.acknowledged_at IS NOT NULL OR prior.provider_turn_id IS NOT NULL)
          )
      )
    ))`;
}
