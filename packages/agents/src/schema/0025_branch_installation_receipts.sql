-- Staging authority must survive crashes and remain tied to the exact Branch plan
-- and Agent creation receipt that own cleanup/publication.
ALTER TABLE branch_installation_resources ADD COLUMN staging_plan_id TEXT;
ALTER TABLE branch_installation_resources ADD COLUMN creation_operation_id TEXT;
CREATE INDEX branch_installation_staging_owner ON branch_installation_resources(staging_plan_id,state);
