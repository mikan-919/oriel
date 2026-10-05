CREATE TABLE transcript_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX transcript_entry_job_idx ON transcript_entry (job_id, sequence);
--> statement-breakpoint
CREATE INDEX transcript_entry_repository_idx ON transcript_entry (repository_owner, repository_name, created_at);
--> statement-breakpoint
CREATE VIRTUAL TABLE transcript_entry_fts USING fts5(
  content,
  tokenize = 'trigram',
  content = 'transcript_entry',
  content_rowid = 'id'
);
--> statement-breakpoint
CREATE TRIGGER transcript_entry_ai AFTER INSERT ON transcript_entry BEGIN
  INSERT INTO transcript_entry_fts(rowid, content) VALUES (new.id, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER transcript_entry_ad AFTER DELETE ON transcript_entry BEGIN
  INSERT INTO transcript_entry_fts(transcript_entry_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
