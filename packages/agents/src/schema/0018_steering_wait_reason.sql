-- Observed safe deferral category, never provider prose or delivery authority.
ALTER TABLE agent_activations ADD COLUMN steering_wait_reason TEXT
  CHECK (steering_wait_reason IN ('provider_not_ready', 'provider_unsupported', 'preparation_retry'));
