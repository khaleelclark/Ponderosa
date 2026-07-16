-- V3.1.1 activation delivery lifecycle. Scheduler Run failures are attempts;
-- these columns preserve the durable delivery outcome on the Activation.

ALTER TABLE agent_activations
  ADD COLUMN delivery_failures INTEGER NOT NULL DEFAULT 0 CHECK (delivery_failures >= 0);
ALTER TABLE agent_activations ADD COLUMN last_delivery_error TEXT;
ALTER TABLE agent_activations
  ADD COLUMN terminal_outcome TEXT CHECK (terminal_outcome IN (
    'recipient_unavailable', 'permanent_failure', 'retry_exhausted'
  ));
ALTER TABLE agent_activations ADD COLUMN terminal_at TEXT;

CREATE INDEX agent_activations_terminal_delivery
  ON agent_activations(terminal_outcome, terminal_at DESC)
  WHERE terminal_outcome IS NOT NULL;
