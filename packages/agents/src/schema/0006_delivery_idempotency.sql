CREATE TABLE IF NOT EXISTS runtime_communication_activation_intake (
  communication_id TEXT NOT NULL
    REFERENCES runtime_communications(id) ON DELETE CASCADE,
  recipient_index INTEGER NOT NULL CHECK (recipient_index >= 0),
  agent_id TEXT NOT NULL,
  activation_id TEXT NOT NULL
    REFERENCES agent_activations(id) ON DELETE CASCADE,
  PRIMARY KEY (communication_id, recipient_index)
);

CREATE INDEX IF NOT EXISTS runtime_communication_activation_intake_activation
  ON runtime_communication_activation_intake (activation_id);
