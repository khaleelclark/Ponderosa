ALTER TABLE runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cached_input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE runs ADD COLUMN reasoning_output_tokens INTEGER;
ALTER TABLE runs ADD COLUMN total_tokens INTEGER;
