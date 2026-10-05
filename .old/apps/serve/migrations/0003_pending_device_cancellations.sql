CREATE TABLE pending_device_cancellations (
  device_id TEXT PRIMARY KEY NOT NULL,
  cancellation_token TEXT NOT NULL,
  cancellation_expires_at INTEGER NOT NULL
);
