import type { Database } from "bun:sqlite";

/**
 * required checkごとの連続失敗回数。
 *
 * [ADR 0007](../../../docs/adr/0007-pull-request-response-job.md)のとおり、
 * PR対応Jobがそのcheckを解消できないまま終わるたびに加算し、checkが
 * success/neutralへ転じた時点で0へ戻す。上限は`limit`が持つ値(3)とする。
 */
export function createPrResponseCheckFailureStore(database: Database) {
  const select = database.query<
    { consecutiveFailures: number },
    [number, string, string]
  >(
    `SELECT consecutive_failures AS consecutiveFailures
     FROM pr_response_check_failures
     WHERE repository_id = ? AND canonical_branch = ? AND check_name = ?`,
  );
  const upsert = database.query(
    `INSERT INTO pr_response_check_failures (
      repository_id, canonical_branch, check_name, consecutive_failures
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(repository_id, canonical_branch, check_name) DO UPDATE SET
      consecutive_failures = excluded.consecutive_failures`,
  );

  function target(
    repositoryId: number,
    canonicalBranch: string,
    checkName: string,
  ) {
    return [repositoryId, canonicalBranch, checkName] as const;
  }

  return {
    count(repositoryId: number, canonicalBranch: string, checkName: string) {
      return (
        select.get(...target(repositoryId, canonicalBranch, checkName))
          ?.consecutiveFailures ?? 0
      );
    },
    /** 解消できないまま終わったJobの後に呼ぶ。加算後の回数を返す。 */
    increment(
      repositoryId: number,
      canonicalBranch: string,
      checkName: string,
    ): number {
      const next =
        (select.get(...target(repositoryId, canonicalBranch, checkName))
          ?.consecutiveFailures ?? 0) + 1;

      upsert.run(repositoryId, canonicalBranch, checkName, next);

      return next;
    },
    reset(repositoryId: number, canonicalBranch: string, checkName: string) {
      upsert.run(repositoryId, canonicalBranch, checkName, 0);
    },
  };
}

export type PrResponseCheckFailureStore = ReturnType<
  typeof createPrResponseCheckFailureStore
>;

/** ADR 0007の収束上限。 */
export const prResponseCheckFailureLimit = 3;
