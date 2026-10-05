CREATE TABLE pull_request_watch (
  job_id TEXT PRIMARY KEY NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  linear_issue_id TEXT NOT NULL,
  status TEXT NOT NULL
);
