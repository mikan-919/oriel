CREATE TABLE issue_comment_outbox (
  operation_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_lease_id TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  body TEXT NOT NULL,
  baseline_comment_ids_json TEXT,
  status TEXT NOT NULL,
  github_comment_id INTEGER,
  UNIQUE(job_id, request_id)
);
