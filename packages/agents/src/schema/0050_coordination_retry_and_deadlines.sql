-- Steering refusals have a retry budget independent of fresh Run delivery.
ALTER TABLE agent_activations ADD COLUMN steering_deferrals INTEGER NOT NULL DEFAULT 0
  CHECK (steering_deferrals >= 0);
