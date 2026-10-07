-- Agent-package creation receipts bind replay authority to one canonical Chat product.
ALTER TABLE agent_creation_operations ADD COLUMN conversation_id TEXT;
ALTER TABLE agent_creation_operations ADD COLUMN product_scope TEXT CHECK(product_scope IS NULL OR product_scope IN ('dev','branches'));
CREATE INDEX agent_creation_operation_destination ON agent_creation_operations(conversation_id,product_scope);
