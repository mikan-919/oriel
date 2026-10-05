import { randomUUID } from "node:crypto";

import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Database } from "bun:sqlite";

import {
  approvedStateName,
  inProgressStateName,
  type ReconcileApproval,
} from "./implementation-admission";
import type { JobOwnershipVerifier } from "./issue-comments";

/** In Progressの反映だけに使う境界。credentialは`serve`が持つ。 */
export interface LinearInProgressPorts {
  /** 現在のworkflow state名。読めない場合はnull。 */
  readLinearState(linearIssueId: string): Promise<string | null>;
  /** TodoからIn Progressへの更新attempt。結果を確定できない場合はfalse。 */
  moveToInProgress(linearIssueId: string): Promise<boolean>;
}

export type MoveToInProgressStatus =
  /** 現在値がIn Progressになった。もともとIn Progressだった場合を含む。 */
  | "in_progress"
  /** 担当権が変わっていた。何も書かない。 */
  | "ownership_not_current"
  /** 承認対象が変わっていた。反映せず、差し戻し経路へ委ねる。 */
  | "approval_changed"
  /** 承認対象を読めない。変わったかどうかを決めずに何も書かない。 */
  | "approval_state_unknown"
  /** 現在stateを読めない。送信もしない。 */
  | "state_unknown"
  /** 人間または他処理がTodo以外へ変えていた。上書きしない。 */
  | "externally_changed"
  /** 送信したが現在値がTodoのまま。結果不明として再読で収束させる。 */
  | "still_todo";

export interface LinearProgressAttempt {
  attemptId: string;
  jobId: string;
  jobLeaseId: string;
  linearIssueId: string;
  operation: "move-to-in-progress";
  approvalFingerprint: string;
  status: "pending" | MoveToInProgressStatus;
}

/**
 * In Progress反映の操作記録。
 *
 * ADR 0005のとおり、送信前に論理操作をローカルSQLiteへ永続化する。用途をこの
 * 一つのstate反映へ限り、WHAT、HOW、本文、承認内容は保存しない。
 */
export function createLinearProgressOutbox(database: Database) {
  const insert = database.query(
    `INSERT INTO linear_progress_outbox (
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
    `UPDATE linear_progress_outbox SET status = ? WHERE attempt_id = ?`,
  );
  const select = database.query<LinearProgressAttempt, [string]>(
    `SELECT
      attempt_id AS attemptId,
      job_id AS jobId,
      job_lease_id AS jobLeaseId,
      linear_issue_id AS linearIssueId,
      operation,
      approval_fingerprint AS approvalFingerprint,
      status
    FROM linear_progress_outbox WHERE attempt_id = ?`,
  );

  return {
    start(attempt: Omit<LinearProgressAttempt, "status">) {
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
    settle(attemptId: string, status: MoveToInProgressStatus) {
      update.run(status, attemptId);
    },
    find(attemptId: string): LinearProgressAttempt | null {
      return select.get(attemptId);
    },
  };
}

export type LinearProgressOutbox = ReturnType<
  typeof createLinearProgressOutbox
>;

export interface MoveApprovalToInProgressOptions {
  database: Database;
  ownership: JobOwnershipVerifier;
  ports: LinearInProgressPorts;
  /** 送信前の承認対象の再調停。変更と読取不能を区別する。 */
  reconcileApproval: ReconcileApproval;
  target: {
    jobId: string;
    jobLeaseId: string;
    repository: GitHubRepository;
    issueNumber: number;
    linearIssueId: string;
    approvalFingerprint: string;
  };
  newAttemptId?: () => string;
}

/**
 * worker起動直後のIn Progress反映。
 *
 * ADR 0005の「Linear状態」とROADMAPのとおり、承認後の機械的な反映として、現在の
 * Job所有権と承認指紋を確認した`serve`だけがTodoからIn Progressへ移す。実行承認
 * そのものは人間のTriage→Todoだけであり、この操作は承認ではない。応答ではなく
 * 更新後に読み直した現在値を正本とし、結果不明ではdesired stateとして現在値が
 * Todoのままの場合だけもう一度だけ送る。payloadの盲目的な再送はしない。
 */
export async function moveApprovalToInProgress({
  database,
  ownership,
  ports,
  reconcileApproval,
  target,
  newAttemptId = randomUUID,
}: MoveApprovalToInProgressOptions): Promise<MoveToInProgressStatus> {
  // 外部操作の直前に、現在のJob取得IDと対象Workflowを確認する。
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

  const approval = await reconcileApproval().catch(
    () => ({ status: "unknown" }) as const,
  );

  if (approval.status === "unknown") {
    return "approval_state_unknown";
  }

  if (
    approval.status === "changed" ||
    approval.approvalFingerprint !== target.approvalFingerprint
  ) {
    return "approval_changed";
  }

  const outbox = createLinearProgressOutbox(database);

  /** 現在値がTodoの場合だけ、記録を残してから一度だけ送る。 */
  const attempt = async (): Promise<MoveToInProgressStatus> => {
    const before = await ports
      .readLinearState(target.linearIssueId)
      .catch(() => null);

    if (before === null) {
      return "state_unknown";
    }

    if (before === inProgressStateName) {
      return "in_progress";
    }

    if (before !== approvedStateName) {
      return "externally_changed";
    }

    const attemptId = newAttemptId();

    outbox.start({
      attemptId,
      jobId: target.jobId,
      jobLeaseId: target.jobLeaseId,
      linearIssueId: target.linearIssueId,
      operation: "move-to-in-progress",
      approvalFingerprint: target.approvalFingerprint,
    });

    await ports.moveToInProgress(target.linearIssueId).catch(() => false);

    const after = await ports
      .readLinearState(target.linearIssueId)
      .catch(() => null);
    const status: MoveToInProgressStatus =
      after === inProgressStateName
        ? "in_progress"
        : after === null || after === approvedStateName
          ? "still_todo"
          : "externally_changed";

    outbox.settle(attemptId, status);

    return status;
  };

  const first = await attempt();

  // 結果不明では、現在値を読み直して同じdesired stateのときだけもう一度送る。
  return first === "still_todo" ? attempt() : first;
}
