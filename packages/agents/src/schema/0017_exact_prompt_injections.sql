-- Preserve exact steering instructions without creating another Run/execution.
-- Historical hashes remain valid; their unavailable text is not reconstructed.
ALTER TABLE scheduler_prompt_injections ADD COLUMN exact_prompt TEXT;
ALTER TABLE scheduler_prompt_injections ADD COLUMN source_manifest_json TEXT;
