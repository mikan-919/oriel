CREATE TABLE model_default_state (
  scope TEXT PRIMARY KEY NOT NULL
);
--> statement-breakpoint
INSERT INTO model_default_state (scope)
SELECT scope FROM model_defaults;
