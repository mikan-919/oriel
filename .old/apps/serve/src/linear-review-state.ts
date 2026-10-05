import { randomUUID } from "node:crypto";

import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Database } from "bun:sqlite";

import {
  inProgressStateName,
  type ReconcileApproval,
} from "./implementation-admission";
import type { JobOwnershipVerifier } from "./issue-comments";
import type { ReviewStateCandidate } from "./linear-approval";

/** レビュー用stateの反映だけに使う境界。credentialは`serve`が持つ。 */
export interface LinearReviewStatePorts {
  readLinearState(linearIssueId: string): Promise<string | null>;
  readReviewStateCandidate(
    linearIssueId: string,
  ): Promise<ReviewStateCandidate | null>;
  moveToStateId(linearIssueId: string, stateId: string): Promise<boolean>;
}

export type ReflectReviewStateStatus =
  /** 一意なレビュー用stateへ移った。もともとそこだった場合を含む。 */
  | "in_review"
  /** teamに一意なレビュー用stateが無いため、In Progressのまま維持した。 */
  | "kept_in_progress"
  | "ownership_not_current"
  | "approval_changed"
  | "approval_state_unknown"
  | "state_unknown"
  | "externally_changed"
  | "still_in_progress";

export interface LinearReviewAttempt {
  attemptId: string;
  jobId: string;
  jobLeaseId: string;
  linearIssueId: string;
  operation: "move-to-review";
  approvalFingerprint: string;
  status: "pending" | ReflectReviewStateStatus;
}

/**
 * レビュー用state反映の操作記録。ADR 0005のとおり送信前に永続化する。
 */
export function createLinearReviewOutbox(database: Database) {
  const insert = database.query(
    `INSERT INTO linear_review_outbox (
      attempt_id, job_id, job_lease_id, linear_issue_id, operation,
      approval_fingerprint, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = database.query(
    `UPDATE linear_review_outbox SET status = ? WHERE attempt_id = ?`,
  );

  return {
    start(attempt: Omit<LinearReviewAttempt, "status">) {
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
    settle(attemptId: string, status: ReflectReviewStateStatus) {
      update.run(status, attemptId);
    },
  };
}

export interface ReflectReviewStateOptions {
  database: Database;
  ownership: JobOwnershipVerifier;
  ports: LinearReviewStatePorts;
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
 * Pull Request作成直後のレビュー用state反映。
 *
 * ADR 0005「Linear状態」のとおり、teamに一意なレビュー用stateがあればそこへ移し、
 * なければIn Progressを維持する。詳細な対応付け規則はADRの対象外のため、
 * type"started"かつ名前が"review"を含むstateが一意な場合だけ採用する。
 */
export async function reflectReviewState({
  database,
  ownership,
  ports,
  reconcileApproval,
  target,
  newAttemptId = randomUUID,
}: ReflectReviewStateOptions): Promise<ReflectReviewStateStatus> {
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

  const candidate = await ports
    .readReviewStateCandidate(target.linearIssueId)
    .catch(() => null);

  if (candidate === null) {
    return "state_unknown";
  }

  if (candidate === "none" || candidate === "ambiguous") {
    return "kept_in_progress";
  }

  const outbox = createLinearReviewOutbox(database);

  const attempt = async (): Promise<ReflectReviewStateStatus> => {
    const before = await ports
      .readLinearState(target.linearIssueId)
      .catch(() => null);

    if (before === null) {
      return "state_unknown";
    }

    if (before === candidate.name) {
      return "in_review";
    }

    if (before !== inProgressStateName) {
      return "externally_changed";
    }

    const attemptId = newAttemptId();

    outbox.start({
      attemptId,
      jobId: target.jobId,
      jobLeaseId: target.jobLeaseId,
      linearIssueId: target.linearIssueId,
      operation: "move-to-review",
      approvalFingerprint: target.approvalFingerprint,
    });

    await ports
      .moveToStateId(target.linearIssueId, candidate.id)
      .catch(() => false);

    const after = await ports
      .readLinearState(target.linearIssueId)
      .catch(() => null);
    const status: ReflectReviewStateStatus =
      after === candidate.name
        ? "in_review"
        : after === null || after === inProgressStateName
          ? "still_in_progress"
          : "externally_changed";

    outbox.settle(attemptId, status);

    return status;
  };

  const first = await attempt();

  return first === "still_in_progress" ? attempt() : first;
}
