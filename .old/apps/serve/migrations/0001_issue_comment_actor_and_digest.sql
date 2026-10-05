ALTER TABLE issue_comment_outbox DROP COLUMN baseline_comment_ids_json;
--> statement-breakpoint
ALTER TABLE issue_comment_outbox ADD COLUMN github_actor_login TEXT;
--> statement-breakpoint
ALTER TABLE issue_comment_outbox ADD COLUMN body_digest TEXT;
