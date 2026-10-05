CREATE TABLE issue_body_outbox (
  operation_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_lease_id TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL
);
