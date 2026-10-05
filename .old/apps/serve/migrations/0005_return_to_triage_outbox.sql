CREATE TABLE return_to_triage_outbox (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  job_lease_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  approval_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL
);
