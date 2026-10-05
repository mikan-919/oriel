import type { Database } from "bun:sqlite";

export interface PullRequestWatchEntry {
  jobId: string;
  repositoryOwner: string;
  repositoryName: string;
  prNumber: number;
  linearIssueId: string;
  status: "watching" | "done";
}

/**
 * merge確認待ちのPull Requestの作業集合。
 *
 * ADR 0005のとおり、これはWHAT/HOWの正本でも操作履歴でもなく、merge検出loopが
 * 見るべき対象を再構成するためだけの索引である。
 */
export function createPullRequestWatchStore(database: Database) {
  return {
    upsert(entry: PullRequestWatchEntry) {
      database
        .query(
          `INSERT INTO pull_request_watch (
            job_id, repository_owner, repository_name, pr_number,
            linear_issue_id, status
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(job_id) DO UPDATE SET
            repository_owner = excluded.repository_owner,
            repository_name = excluded.repository_name,
            pr_number = excluded.pr_number,
            linear_issue_id = excluded.linear_issue_id,
            status = excluded.status`,
        )
        .run(
          entry.jobId,
          entry.repositoryOwner,
          entry.repositoryName,
          entry.prNumber,
          entry.linearIssueId,
          entry.status,
        );
    },
    watching(): PullRequestWatchEntry[] {
      return database
        .query(
          `SELECT
            job_id AS jobId,
            repository_owner AS repositoryOwner,
            repository_name AS repositoryName,
            pr_number AS prNumber,
            linear_issue_id AS linearIssueId,
            status
          FROM pull_request_watch WHERE status = 'watching'`,
        )
        .all() as PullRequestWatchEntry[];
    },
    markDone(jobId: string) {
      database
        .query(`UPDATE pull_request_watch SET status = 'done' WHERE job_id = ?`)
        .run(jobId);
    },
  };
}

export type PullRequestWatchStore = ReturnType<
  typeof createPullRequestWatchStore
>;
