-- Exact scheduled-update authority checks also inspect attachment by Activation.
-- Keep the reverse proof indexed without changing its Run/fence semantics.
CREATE INDEX scheduler_run_activations_by_activation
  ON scheduler_run_activations(activation_id,run_id);

-- Target eligibility checks the exact Run's outstanding recovery authority.
CREATE INDEX scheduler_steering_recoveries_by_run
  ON scheduler_steering_recoveries(run_id)
  WHERE state IN ('grace_period','wait_for_run','recovery_queued');
