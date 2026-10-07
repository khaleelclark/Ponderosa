-- Preserve product ownership after canonical Project rows disappear so
-- workspace deletion events remain safely scopeable during live delivery and replay.
ALTER TABLE project_deletion_receipts
  ADD COLUMN product_scope TEXT NOT NULL DEFAULT 'dev' CHECK(product_scope IN ('dev','branches'));

-- Older completed receipts predate explicit product ownership. Infer Branch-only
-- receipts when durable Chat deletion evidence can prove that ownership; all
-- ambiguous and empty legacy receipts remain in the conservative Dev scope.
UPDATE project_deletion_receipts
SET product_scope = 'branches'
WHERE EXISTS (
  SELECT 1 FROM conversation_deletion_receipts receipt
  WHERE receipt.project_id = project_deletion_receipts.project_id
    AND receipt.branch_id IS NOT NULL
) AND NOT EXISTS (
  SELECT 1 FROM conversation_deletion_receipts receipt
  WHERE receipt.project_id = project_deletion_receipts.project_id
    AND receipt.branch_id IS NULL
);


-- Agent deletion replay cannot depend on short-lived storage tombstones. Keep
-- the exact uniform product scope (or mixed/unknown fail-closed state) beside
-- the immutable deleted Agent inventory.
ALTER TABLE agent_deletion_receipts
  ADD COLUMN product_scope TEXT NOT NULL DEFAULT 'unknown'
  CHECK(product_scope IN ('dev','branches','mixed','unknown'));

UPDATE agent_deletion_receipts
SET product_scope = CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM json_each(agent_deletion_receipts.deleted_agent_ids_json) ids
    WHERE NOT (
      EXISTS (SELECT 1 FROM branch_installation_resources resource WHERE resource.local_id = ids.value)
      OR EXISTS (
        SELECT 1 FROM agent_deletion_tombstones removed_agent
        LEFT JOIN conversations chat ON chat.id = removed_agent.conversation_id
        LEFT JOIN conversation_deletion_receipts removed_chat ON removed_chat.conversation_id = removed_agent.conversation_id
        WHERE removed_agent.agent_id = ids.value
          AND COALESCE(chat.branch_id, removed_chat.branch_id) IS NOT NULL
      )
    )
  ) THEN 'branches'
  WHEN NOT EXISTS (
    SELECT 1 FROM json_each(agent_deletion_receipts.deleted_agent_ids_json) ids
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_deletion_tombstones removed_agent
      LEFT JOIN conversations chat ON chat.id = removed_agent.conversation_id
      LEFT JOIN conversation_deletion_receipts removed_chat ON removed_chat.conversation_id = removed_agent.conversation_id
      WHERE removed_agent.agent_id = ids.value
        AND COALESCE(chat.branch_id, removed_chat.branch_id) IS NULL
    )
  ) THEN 'dev'
  WHEN NOT EXISTS (
    SELECT 1 FROM json_each(agent_deletion_receipts.deleted_agent_ids_json) ids
    WHERE NOT (
      EXISTS (SELECT 1 FROM branch_installation_resources resource WHERE resource.local_id = ids.value)
      OR EXISTS (SELECT 1 FROM agent_deletion_tombstones removed_agent WHERE removed_agent.agent_id = ids.value)
    )
  ) THEN 'mixed'
  ELSE 'unknown'
END;
