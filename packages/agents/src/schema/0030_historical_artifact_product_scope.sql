-- Older Dev installations may have completed Agent deletion receipts after the
-- short-lived filesystem tombstone was cleaned. At 0028 those receipts were
-- conservatively marked unknown. A Project with recorded Dev Chat ownership
-- and no Branch-owned Chat/resource history can be classified without guessing.
-- Leave mixed or evidence-free Projects unknown rather than crossing products.
UPDATE agent_deletion_receipts AS receipt
SET product_scope='dev'
WHERE receipt.product_scope='unknown'
  AND EXISTS (
    SELECT 1 FROM conversations chat
    WHERE chat.project_id=receipt.project_id AND chat.branch_id IS NULL
    UNION ALL
    SELECT 1 FROM conversation_deletion_receipts removed_chat
    WHERE removed_chat.project_id=receipt.project_id AND removed_chat.branch_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM conversations chat
    WHERE chat.project_id=receipt.project_id AND chat.branch_id IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM conversation_deletion_receipts removed_chat
    WHERE removed_chat.project_id=receipt.project_id AND removed_chat.branch_id IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM branch_installation_resources resource
    JOIN agents agent ON agent.id=resource.local_id
    WHERE agent.project_id=receipt.project_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM branch_installation_resources resource
    JOIN conversations chat ON chat.id=resource.local_id
    WHERE chat.project_id=receipt.project_id
  );
