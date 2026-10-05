CREATE TABLE job_state (
  job_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
