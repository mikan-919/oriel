CREATE TABLE checkpoint_outbox (
  operation_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_lease_id TEXT NOT NULL,
  branch_lease_id TEXT NOT NULL,
  approval_fingerprint TEXT NOT NULL,
  canonical_branch TEXT NOT NULL,
  expected_oid TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  verified INTEGER NOT NULL,
  status TEXT NOT NULL,
  canonical_oid TEXT,
  UNIQUE(job_id, request_id)
);
