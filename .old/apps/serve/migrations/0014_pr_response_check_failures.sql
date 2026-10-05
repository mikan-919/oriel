CREATE TABLE pr_response_check_failures (
  repository_id INTEGER NOT NULL,
  canonical_branch TEXT NOT NULL,
  check_name TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL,
  PRIMARY KEY (repository_id, canonical_branch, check_name)
);
