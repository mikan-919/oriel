import type { Database } from "bun:sqlite";

/** ADR 0004/0005で`serve`が持つJob実行状態のうち、この経路で必要な最小の値。 */
export type JobExecutionStatus = "running" | "interrupted" | "completed";

export interface JobStateStore {
  set(jobId: string, status: JobExecutionStatus): void;
  get(jobId: string): JobExecutionStatus | null;
}

export function createJobStateStore(
  database: Database,
  now: () => number = Date.now,
): JobStateStore {
  const upsert = database.query(
    `INSERT INTO job_state (job_id, status, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
  );
  const select = database.query<{ status: string }, [string]>(
    `SELECT status FROM job_state WHERE job_id = ?`,
  );

  return {
    set(jobId, status) {
      upsert.run(jobId, status, now());
    },
    get(jobId) {
      const row = select.get(jobId);

      return row?.status === "running" ||
        row?.status === "interrupted" ||
        row?.status === "completed"
        ? row.status
        : null;
    },
  };
}
