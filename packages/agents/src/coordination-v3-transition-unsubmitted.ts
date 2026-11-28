function runUnsubmittedSql(run:string):string {
  return `(${run}.prompt_injection_state='not_injected' AND ${run}.started_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM provider_inputs input WHERE input.scheduler_run_id=${run}.id OR input.execution_id=${run}.id)
    AND NOT EXISTS(SELECT 1 FROM scheduler_prompt_injections injection WHERE injection.run_id=${run}.id
      AND (injection.state NOT IN ('pending','cancelled') OR injection.submitted_at IS NOT NULL
        OR injection.acknowledged_at IS NOT NULL OR injection.provider_turn_id IS NOT NULL)))`;
}

/** Exact queued work can be resumed after pre-injection failures only if
 * every historical attachment belongs to a terminal unstarted Run. This
 * contains the scheduler's canRetryUninjectedRun checks and additionally
 * rejects contradictory submission evidence and cross-scope Run bindings.
 * A definite steering refusal can also leave the exact input unsubmitted. */
export function transitionUnsubmittedActivationSql(activation:string):string {
  return `((${activation}.state='pending' AND NOT EXISTS (
      SELECT 1 FROM scheduler_run_activations attached WHERE attached.activation_id=${activation}.id))
    OR (${activation}.state IN ('pending','retry_pending')
      AND EXISTS (SELECT 1 FROM scheduler_run_activations attached WHERE attached.activation_id=${activation}.id)
      AND NOT EXISTS (
        SELECT 1 FROM scheduler_run_activations attached
        LEFT JOIN scheduler_runs run ON run.id=attached.run_id
        WHERE attached.activation_id=${activation}.id AND (
          run.id IS NULL OR run.project_id<>${activation}.project_id OR run.agent_id<>${activation}.agent_id
          OR run.scope_key<>${activation}.scope_key OR run.status NOT IN ('failed','cancelled')
          OR run.terminal_at IS NULL OR attached.consumed_at IS NOT NULL
          OR NOT ${runUnsubmittedSql('run')}
        )
      ))
    OR (CASE WHEN ${activation}.state='retry_pending'
      AND ${activation}.kind='human_message' AND ${activation}.prompt_class='human'
      AND ${activation}.steering_wait_reason IN ('provider_not_ready','provider_unsupported','preparation_retry')
      THEN (
        -- Steer can leave attachments to a completed Run even though none
        -- of the attempts were accepted. Every attempt must agree.
        WITH attempts AS (
          SELECT injection.run_id, CASE WHEN
            injection.kind='steer' AND injection.state='cancelled'
            AND injection.terminal_at IS NOT NULL AND injection.acknowledged_at IS NULL
            AND injection.provider_turn_id IS NULL AND source.status='completed'
            AND source.terminal_at IS NOT NULL AND source.prompt_injection_state='injected'
            AND source.project_id=${activation}.project_id AND source.agent_id=${activation}.agent_id
            AND source.scope_key=${activation}.scope_key
            THEN 1 ELSE 0 END AS refused
          FROM scheduler_prompt_injections injection
          LEFT JOIN scheduler_runs source ON source.id=injection.run_id,
            json_each(injection.activation_ids_json) member
          WHERE member.value=${activation}.id
        )
        SELECT coalesce(min(refused),0)=1 AND NOT EXISTS (
          SELECT 1 FROM scheduler_run_activations attached
          WHERE attached.activation_id=${activation}.id
            AND attached.run_id NOT IN (SELECT run_id FROM attempts)
        )
        FROM attempts
      )
      ELSE 0 END)
    OR (CASE WHEN ${activation}.state='retry_pending' AND ${activation}.dispatch_policy='next_run'
      AND ${activation}.steering_wait_reason='provider_unsupported'
      AND (${activation}.kind IN ('coordination_request','ordinary_message')
        OR (${activation}.kind='urgent_message' AND ${activation}.prompt_class<>'human'))
      THEN NOT EXISTS (SELECT 1 FROM scheduler_run_activations attached WHERE attached.activation_id=${activation}.id)
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
      ELSE 0 END))`;
}

/** True when nothing yet proves the exact Run's provider processes exited: an
 * unexited registration, a live authority, an unsettled or unknown start, or no
 * registration at all. A never-injected Run with no durable start admission is
 * proven never started, because every provider spawn requires one. */
export function runExitUnprovenSql(run:string,injection:string):string {
  return `(EXISTS(SELECT 1 FROM provider_process_authority live WHERE live.run_id=${run})
    OR EXISTS(SELECT 1 FROM host_lifecycle_commits registration WHERE registration.kind='provider-process-registration'
      AND json_extract(registration.receipt_json,'$.runId')=${run} AND NOT EXISTS(SELECT 1 FROM host_lifecycle_commits exited
        WHERE exited.kind='provider-process-exit' AND exited.identity=json_extract(registration.receipt_json,'$.authorityId')
          AND json_extract(exited.receipt_json,'$.result')='observed_exited'))
    OR EXISTS(SELECT 1 FROM host_lifecycle_commits claim WHERE claim.kind='provider-start-admission'
      AND json_extract(claim.receipt_json,'$.runId')=${run} AND (EXISTS(SELECT 1 FROM host_lifecycle_commits unknown
        WHERE unknown.kind='provider-start-unknown' AND unknown.identity=claim.identity) OR NOT EXISTS(SELECT 1 FROM host_lifecycle_commits settled
        WHERE settled.kind='provider-start-settlement' AND settled.identity=claim.identity)))
    OR NOT EXISTS(SELECT 1 FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.runId')=${run})
      AND (${injection}<>'not_injected' OR EXISTS(SELECT 1 FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.runId')=${run})))`;
}

/** Every handoff Run must be terminal, unsubmitted and drained. Keep all
 * failed Runs and receipts as history when a new rollover is later reserved. */
export function failedSettingsHandoffUnsubmittedSql(rollover:string):string {
  return `(${rollover}.state='failed' AND ${rollover}.terminal_at IS NOT NULL
    AND ${rollover}.handoff_event_id IS NULL AND ${rollover}.replacement_run_id IS NULL
    AND ${rollover}.continuation_activation_id IS NULL AND ${rollover}.replacement_session_id IS NULL
    AND NOT EXISTS(
      SELECT 1 FROM activation_sources source
      JOIN agent_activations handoff ON handoff.id=source.activation_id
      LEFT JOIN scheduler_run_activations attached ON attached.activation_id=handoff.id
      LEFT JOIN scheduler_runs run ON run.id=attached.run_id
      WHERE source.source_kind='context_rollover' AND source.source_id=${rollover}.id
        AND (handoff.kind<>'context_rollover_handoff' OR handoff.project_id<>${rollover}.project_id
          OR handoff.agent_id<>${rollover}.agent_id OR handoff.scope_key<>${rollover}.scope_key
          OR handoff.state NOT IN ('failed','cancelled') OR handoff.terminal_at IS NULL
          OR attached.run_id IS NOT NULL AND (
            run.id IS NULL OR run.project_id<>handoff.project_id OR run.agent_id<>handoff.agent_id
            OR run.scope_key<>handoff.scope_key OR run.status NOT IN ('failed','cancelled')
            OR run.terminal_at IS NULL OR attached.consumed_at IS NOT NULL OR NOT ${runUnsubmittedSql('run')}
            OR ${runExitUnprovenSql('run.id','run.prompt_injection_state')}
            OR EXISTS(SELECT 1 FROM provider_operation_outbox operation WHERE operation.run_id=run.id AND operation.state<>'completed')
          ))
    ))`;
}
