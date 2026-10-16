ALTER TABLE agent_activations ADD COLUMN provider_failure_category TEXT CHECK (
  provider_failure_category IS NULL OR provider_failure_category IN (
    'authentication', 'rate_limit', 'capacity', 'context_length',
    'invalid_request', 'unavailable', 'unknown'
  )
);

ALTER TABLE context_rollovers ADD COLUMN failure_signal TEXT CHECK (
  failure_signal IS NULL OR failure_signal IN ('seed_overflow', 'replacement_cancelled')
);

UPDATE agent_activations
SET provider_failure_category = CASE
  WHEN last_delivery_error LIKE '[capacity] %'
    OR last_delivery_error = 'Provider is temporarily at capacity.' THEN 'capacity'
  WHEN last_delivery_error LIKE '[rate_limit] %'
    OR last_delivery_error = 'Provider usage limit was reached.' THEN 'rate_limit'
  ELSE provider_failure_category
END
WHERE provider_failure_category IS NULL;

UPDATE context_rollovers
SET failure_signal = 'seed_overflow'
WHERE failure_signal IS NULL AND last_error LIKE 'rollover_seed_overflow:%';

UPDATE context_rollovers
SET failure_signal = 'replacement_cancelled'
WHERE failure_signal IS NULL
  AND last_error = 'replacement Run was cancelled before low-water context confirmation';
