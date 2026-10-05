import { randomUUID } from "node:crypto";

import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Database } from "bun:sqlite";

import type { JobOwnershipVerifier } from "./issue-comments";

/** 実行承認とみなすstateと、承認を差し戻す先のstate。 */
const approvedStateName = "Todo";
const triageStateName = "Triage";

/** Linear stateの現在値だけを読み書きする境界。credentialは`serve`が持つ。 */
export interface LinearApprovalStatePorts {
  /** 現在のworkflow state名。読めない場合はnull。 */
  readLinearState(linearIssueId: string): Promise<string | null>;
  /** TodoからTriageへの更新attempt。結果を確定できない場合はfalse。 */
  moveToTriage(linearIssueId: string): Promise<boolean>;
}

export type ReturnToTriageStatus =
  /** 現在値がTriageになった。もともとTriageだった場合を含む。 */
  | "returned"
  /** 人間または他処理がTodo以外へ変えていた。上書きしない。 */
  | "externally_changed"
  /** 担当権が変わっていた。何も書かない。 */
  | "ownership_not_current"
  /** 現在stateを読めない。送信もしない。 */
  | "state_unknown"
  /** 失敗または結果不明。Jobは`interrupted`のままにする。 */
  | "still_todo";

export interface ReturnToTriageAttempt {
  attemptId: string;
  jobId: string;
  jobLeaseId: string;
  linearIssueId: string;
  operation: "return-to-triage";
  approvalFingerprint: string;
  status: "pending" | ReturnToTriageStatus;
}

/**
 * 差し戻しの操作記録。
 *
 * ADR 0003手順4のとおり、更新送信前にJob識別子、Job取得ID、対象Linear Issue、
 * 操作種別、一意な試行IDを永続化し、この試行IDを内部の冪等性キーにする。本文や
 * 承認内容は保存しない。
 */
export function createReturnToTriageOutbox(database: Database) {
  const insert = database.query(
    `INSERT INTO return_to_triage_outbox (
      attempt_id,
      job_id,
      job_lease_id,
      linear_issue_id,
      operation,
      approval_fingerprint,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = database.query(
    `UPDATE return_to_triage_outbox SET status = ? WHERE attempt_id = ?`,
  );
  const select = database.query<ReturnToTriageAttempt, [string]>(
    `SELECT
      attempt_id AS attemptId,
      job_id AS jobId,
      job_lease_id AS jobLeaseId,
      linear_issue_id AS linearIssueId,
      operation,
      approval_fingerprint AS approvalFingerprint,
      status
    FROM return_to_triage_outbox WHERE attempt_id = ?`,
  );

  return {
    start(attempt: Omit<ReturnToTriageAttempt, "status">) {
      insert.run(
        attempt.attemptId,
        attempt.jobId,
        attempt.jobLeaseId,
        attempt.linearIssueId,
        attempt.operation,
        attempt.approvalFingerprint,
        "pending",
      );
    },
    settle(attemptId: string, status: ReturnToTriageStatus) {
      update.run(status, attemptId);
    },
    find(attemptId: string): ReturnToTriageAttempt | null {
      return select.get(attemptId);
    },
  };
}

export type ReturnToTriageOutbox = ReturnType<
  typeof createReturnToTriageOutbox
>;

export interface ReturnToTriageTarget {
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
  linearIssueId: string;
  approvalFingerprint: string;
}

export interface ReturnApprovalToTriageOptions {
  database: Database;
  ownership: JobOwnershipVerifier;
  ports: LinearApprovalStatePorts;
  target: ReturnToTriageTarget;
  newAttemptId?: () => string;
}

/**
 * 無効になった承認状態をLinearへ機械的に反映する。
 *
 * ADR 0003「現在値の一致とTriageへの差し戻し」の手順2〜5だけを行う。差し戻せる
 * のは、現在のJob所有権接続と対象Workflowを確認できた信頼された`serve`だけで
 * あり、リレー、Agent、harnessはこの経路を持たない。credentialも`serve`の外へ
 * 出さない。理由commentは投稿せず、Todoのまま残った試行を自動再送もしない。
 */
export async function returnApprovalToTriage({
  database,
  ownership,
  ports,
  target,
  newAttemptId = randomUUID,
}: ReturnApprovalToTriageOptions): Promise<ReturnToTriageStatus> {
  // 手順2: 現在のJob取得IDと対象Workflowを再確認する。変わっていたら何も書かない。
  const current = await Promise.resolve(
    ownership.hasCurrentJobOwnership({
      jobId: target.jobId,
      jobLeaseId: target.jobLeaseId,
      repository: target.repository,
      issueNumber: target.issueNumber,
    }),
  ).catch(() => false);

  if (!current) {
    return "ownership_not_current";
  }

  // 手順3: 現在stateを読み直す。Todoの場合だけ更新attemptを作る。
  const before = await ports
    .readLinearState(target.linearIssueId)
    .catch(() => null);

  if (before === null) {
    return "state_unknown";
  }

  if (before === triageStateName) {
    return "returned";
  }

  if (before !== approvedStateName) {
    return "externally_changed";
  }

  // 手順4: 送信前に一意な試行IDの操作記録を永続化し、同じ試行を二度送らない。
  const outbox = createReturnToTriageOutbox(database);
  const attemptId = newAttemptId();

  outbox.start({
    attemptId,
    jobId: target.jobId,
    jobLeaseId: target.jobLeaseId,
    linearIssueId: target.linearIssueId,
    operation: "return-to-triage",
    approvalFingerprint: target.approvalFingerprint,
  });

  await ports.moveToTriage(target.linearIssueId).catch(() => false);

  // 手順5: 応答ではなく、更新後に読み直した現在値を正本として扱う。
  const after = await ports
    .readLinearState(target.linearIssueId)
    .catch(() => null);
  const status: ReturnToTriageStatus =
    after === triageStateName
      ? "returned"
      : after === null || after === approvedStateName
        ? "still_todo"
        : "externally_changed";

  outbox.settle(attemptId, status);

  return status;
}
