CREATE TABLE linear_comment_outbox (
  operation_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_lease_id TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  linear_issue_id TEXT NOT NULL,
  body TEXT NOT NULL,
  linear_actor_id TEXT,
  body_digest TEXT,
  status TEXT NOT NULL,
  linear_comment_id TEXT
);
