CREATE TABLE linear_triage_link_outbox (
  operation_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_lease_id TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  linear_issue_id TEXT,
  status TEXT NOT NULL
);
