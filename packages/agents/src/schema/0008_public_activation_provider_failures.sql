UPDATE agent_activations
SET provider_failure_category = COALESCE(
  provider_failure_category,
  (
    SELECT CASE json_extract(
      CASE WHEN json_valid(scheduler.provider_failure_json)
        THEN scheduler.provider_failure_json ELSE '{}' END,
      '$.category'
    )
      WHEN 'authentication' THEN 'authentication'
      WHEN 'rate_limit' THEN 'rate_limit'
      WHEN 'capacity' THEN 'capacity'
      WHEN 'context_length' THEN 'context_length'
      WHEN 'invalid_request' THEN 'invalid_request'
      WHEN 'unavailable' THEN 'unavailable'
      WHEN 'unknown' THEN 'unknown'
      ELSE 'unknown'
    END
    FROM scheduler_run_activations attached
    JOIN scheduler_runs scheduler ON scheduler.id = attached.run_id
    WHERE attached.activation_id = agent_activations.id
      AND scheduler.provider_failure_json IS NOT NULL
    ORDER BY attached.attached_at DESC, attached.run_id DESC
    LIMIT 1
  )
)
WHERE provider_failure_category IS NULL
  AND EXISTS (
    SELECT 1
    FROM scheduler_run_activations attached
    JOIN scheduler_runs scheduler ON scheduler.id = attached.run_id
    WHERE attached.activation_id = agent_activations.id
      AND scheduler.provider_failure_json IS NOT NULL
  );

UPDATE agent_activations
SET last_delivery_error = CASE provider_failure_category
  WHEN 'authentication' THEN 'Provider authentication was rejected.'
  WHEN 'rate_limit' THEN 'Provider usage limit was reached.'
  WHEN 'capacity' THEN 'Provider is temporarily at capacity.'
  WHEN 'context_length' THEN 'Provider context limit was reached.'
  WHEN 'invalid_request' THEN 'Provider rejected the request.'
  WHEN 'unavailable' THEN 'Provider is temporarily unavailable.'
  ELSE 'Provider execution failed.'
END
WHERE provider_failure_category IS NOT NULL
  AND last_delivery_error IS NOT NULL;
