CREATE TABLE linear_done_outbox (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL
);
