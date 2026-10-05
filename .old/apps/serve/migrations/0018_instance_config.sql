CREATE TABLE instance_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  relay_origin TEXT,
  repository_id INTEGER,
  repository_owner TEXT,
  repository_name TEXT,
  repository_root TEXT,
  worktrees_root TEXT,
  linear_team_id TEXT,
  canonical_remote TEXT,
  lm_studio_base_url TEXT,
  initialized INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO instance_config (id, initialized) VALUES (1, 0);
