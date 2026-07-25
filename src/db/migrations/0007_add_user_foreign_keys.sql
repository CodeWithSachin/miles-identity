-- 0007_add_user_foreign_keys.sql
-- Foreign keys from our tables to Better Auth's "user".
--
-- Deferred from step 2: "user" is owned by Better Auth and did not exist until
-- `bunx auth migrate` created it in step 3. This migration MUST run after that
-- CLI migration. Our tables were created with `user_id text NOT NULL` and no FK
-- precisely so this constraint could arrive once "user" existed.
--
-- These tables are still empty, so a plain (locking) ADD CONSTRAINT is instant.
-- Every referenced column is already indexed by 0002/0004/0005, so no index is
-- added here. See .agents/skills/postgres-migrations.md.
--
-- "user" is a reserved word — always quoted. No FK on user_product_access.granted_by
-- (may be a non-user system actor) or user.merged_into_user_id (a soft pointer set
-- by the merge writer in step 9; users are never hard-deleted, so integrity holds).

ALTER TABLE user_identity
  ADD CONSTRAINT fk_identity_user
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;

ALTER TABLE user_product_access
  ADD CONSTRAINT fk_access_user
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;

-- The merge log is an append-only audit trail: never cascade-delete its rows.
ALTER TABLE identity_merge_log
  ADD CONSTRAINT fk_merge_survivor
  FOREIGN KEY (survivor_user_id) REFERENCES "user"(id);

ALTER TABLE identity_merge_log
  ADD CONSTRAINT fk_merge_merged
  FOREIGN KEY (merged_user_id) REFERENCES "user"(id);
