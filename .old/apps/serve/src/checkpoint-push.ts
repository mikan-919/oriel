import { randomUUID } from "node:crypto";

import type {
  CheckpointAcceptedEvent,
  CheckpointCompletedEvent,
  CheckpointRejectedEvent,
  CheckpointRequest,
  GitHubRepository,
} from "@mikan-919/oriel-contracts";
import type { Database } from "bun:sqlite";

import type { CheckpointPushResult } from "./canonical-worktree";
import type { GitCredential } from "./git";
import type { ReconcileApproval } from "./implementation-admission";
import type { JobOwnershipVerifier } from "./issue-comments";

/** 実装Jobがcheckpointを送ってよい唯一の対象。 */
export interface CheckpointBinding {
  jobId: string;
  jobLeaseId: string;
  branchLeaseId: string;
  /** relayのブランチ排他キー。 */
  branchKey: string;
  approvalFingerprint: string;
  canonicalBranch: string;
  repository: GitHubRepository;
  issueNumber: number;
}

export interface BranchOwnershipVerifier extends JobOwnershipVerifier {
  hasCurrentBranchExclusivity(
    branchKey: string,
    branchLeaseId: string,
  ): boolean | Promise<boolean>;
}

type CheckpointOperationStatus = "pending" | "completed" | "rejected";

export interface CheckpointOperation {
  operationId: string;
  requestId: string;
  jobId: string;
  jobLeaseId: string;
  branchLeaseId: string;
  approvalFingerprint: string;
  canonicalBranch: string;
  expectedOid: string;
  headOid: string;
  verified: boolean;
  status: CheckpointOperationStatus;
  canonicalOid: string | null;
}

interface CheckpointOperationRow {
  operationId: string;
  requestId: string;
  jobId: string;
  jobLeaseId: string;
  branchLeaseId: string;
  approvalFingerprint: string;
  canonicalBranch: string;
  expectedOid: string;
  headOid: string;
  verified: number;
  status: CheckpointOperationStatus;
  canonicalOid: string | null;
}

const selectOperationSql = `SELECT
    operation_id AS operationId,
    request_id AS requestId,
    job_id AS jobId,
    job_lease_id AS jobLeaseId,
    branch_lease_id AS branchLeaseId,
    approval_fingerprint AS approvalFingerprint,
    canonical_branch AS canonicalBranch,
    expected_oid AS expectedOid,
    head_oid AS headOid,
    verified,
    status,
    canonical_oid AS canonicalOid
  FROM checkpoint_outbox`;

/**
 * checkpoint送信の操作記録。
 *
 * ADR 0005のとおり、論理操作を送信前にSQLiteへ永続化し、操作IDを即時返せる
 * ようにする。WHATやHOWの本文は保存せず、比較条件と対象だけを持つ。
 */
export function createCheckpointOutbox(database: Database) {
  return {
    enqueue(operation: CheckpointOperation) {
      database
        .query(
          `INSERT INTO checkpoint_outbox (
            operation_id,
            request_id,
            job_id,
            job_lease_id,
            branch_lease_id,
            approval_fingerprint,
            canonical_branch,
            expected_oid,
            head_oid,
            verified,
            status,
            canonical_oid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.operationId,
          operation.requestId,
          operation.jobId,
          operation.jobLeaseId,
          operation.branchLeaseId,
          operation.approvalFingerprint,
          operation.canonicalBranch,
          operation.expectedOid,
          operation.headOid,
          operation.verified ? 1 : 0,
          operation.status,
          operation.canonicalOid,
        );
    },
    find(operationId: string): CheckpointOperation | null {
      const row = database
        .query(`${selectOperationSql} WHERE operation_id = ?`)
        .get(operationId) as CheckpointOperationRow | null;

      return row === null ? null : fromRow(row);
    },
    findByRequest(
      jobId: string,
      requestId: string,
    ): CheckpointOperation | null {
      const row = database
        .query(`${selectOperationSql} WHERE job_id = ? AND request_id = ?`)
        .get(jobId, requestId) as CheckpointOperationRow | null;

      return row === null ? null : fromRow(row);
    },
    complete(operationId: string, canonicalOid: string) {
      database
        .query(
          `UPDATE checkpoint_outbox
          SET status = 'completed', canonical_oid = ?
          WHERE operation_id = ?`,
        )
        .run(canonicalOid, operationId);
    },
    reject(operationId: string) {
      database
        .query(
          `UPDATE checkpoint_outbox SET status = 'rejected' WHERE operation_id = ?`,
        )
        .run(operationId);
    },
  };
}

function fromRow(row: CheckpointOperationRow): CheckpointOperation {
  return { ...row, verified: row.verified === 1 };
}

export type CheckpointOutbox = ReturnType<typeof createCheckpointOutbox>;

export interface CheckpointServiceDependencies {
  outbox: CheckpointOutbox;
  binding: CheckpointBinding;
  ownership: BranchOwnershipVerifier;
  /**
   * 送信直前の再調停。現在値から導いた承認指紋を返す。承認が変わった場合と、
   * 読めずに決められない場合を区別する。
   */
  reconcileApproval: ReconcileApproval;
  /** 用途をimplementationへ絞った一回限りのcredential。 */
  resolveCredential: () => Promise<GitCredential | null>;
  push: (input: {
    canonicalBranch: string;
    expectedOid: string;
    headOid: string;
    credential: GitCredential;
  }) => Promise<CheckpointPushResult>;
  newOperationId?: () => string;
}

/**
 * checkpointをcanonicalブランチへ送る用途限定操作。
 *
 * harnessはcredentialも遠隔Gitも持たない。`serve`は要求の対象と現在の取得IDを
 * 確認し、送信直前に承認指紋を再調停してからだけ書き込む。
 */
export function createCheckpointService({
  outbox,
  binding,
  ownership,
  reconcileApproval,
  resolveCredential,
  push,
  newOperationId = randomUUID,
}: CheckpointServiceDependencies) {
  async function accept(
    request: CheckpointRequest,
  ): Promise<CheckpointAcceptedEvent | CheckpointRejectedEvent> {
    if (!matchesBinding(request, binding)) {
      return rejected(request.requestId, "target_mismatch");
    }

    if (!(await hasCurrentOwnership())) {
      return rejected(request.requestId, "ownership_not_current");
    }

    const existing = outbox.findByRequest(request.jobId, request.requestId);

    if (existing !== null) {
      return sameOperation(existing, request)
        ? accepted(request.requestId, existing.operationId)
        : rejected(request.requestId, "invalid_request");
    }

    const operationId = newOperationId();

    outbox.enqueue({
      operationId,
      requestId: request.requestId,
      jobId: request.jobId,
      jobLeaseId: request.jobLeaseId,
      branchLeaseId: request.branchLeaseId,
      approvalFingerprint: request.approvalFingerprint,
      canonicalBranch: request.canonicalBranch,
      expectedOid: request.expectedOid,
      headOid: request.headOid,
      verified: request.verified,
      status: "pending",
      canonicalOid: null,
    });

    return accepted(request.requestId, operationId);
  }

  async function deliver(
    operationId: string,
  ): Promise<CheckpointCompletedEvent | CheckpointRejectedEvent> {
    const operation = outbox.find(operationId);

    if (operation === null) {
      return rejected("unknown-operation", "invalid_request");
    }

    if (operation.status === "completed") {
      return completed(operation);
    }

    if (operation.status === "rejected") {
      return rejected(operation.requestId, "push_failed");
    }

    if (!(await hasCurrentOwnership())) {
      return finishRejected(operation, "ownership_not_current");
    }

    // ADR 0003: 外部操作の直前に現在の承認指紋を再調停する。
    const current = await reconcileApproval().catch(
      () => ({ status: "unknown" }) as const,
    );

    // 読めなかっただけの提供元障害を、承認の変更として差し戻さない。
    if (current.status === "unknown") {
      return finishRejected(operation, "approval_state_unknown");
    }

    if (
      current.status === "changed" ||
      current.approvalFingerprint !== operation.approvalFingerprint
    ) {
      return finishRejected(operation, "target_mismatch");
    }

    const credential = await resolveCredential().catch(() => null);

    if (credential === null) {
      return finishRejected(operation, "push_failed");
    }

    const pushed = await push({
      canonicalBranch: operation.canonicalBranch,
      expectedOid: operation.expectedOid,
      headOid: operation.headOid,
      credential,
    }).catch(() => ({ status: "failed" }) as CheckpointPushResult);

    if (pushed.status === "pushed") {
      outbox.complete(operation.operationId, pushed.canonicalOid);
      return completed(outbox.find(operation.operationId) ?? operation);
    }

    return finishRejected(
      operation,
      pushed.status === "diverged" ? "remote_diverged" : "push_failed",
    );
  }

  function finishRejected(
    operation: CheckpointOperation,
    reason: CheckpointRejectedEvent["reason"],
  ): CheckpointRejectedEvent {
    outbox.reject(operation.operationId);
    return rejected(operation.requestId, reason);
  }

  async function hasCurrentOwnership(): Promise<boolean> {
    return (
      (await ownership.hasCurrentJobOwnership({
        jobId: binding.jobId,
        jobLeaseId: binding.jobLeaseId,
        repository: binding.repository,
        issueNumber: binding.issueNumber,
      })) &&
      (await ownership.hasCurrentBranchExclusivity(
        binding.branchKey,
        binding.branchLeaseId,
      ))
    );
  }

  return { accept, deliver };
}

function matchesBinding(
  request: CheckpointRequest,
  binding: CheckpointBinding,
): boolean {
  return (
    request.jobId === binding.jobId &&
    request.jobLeaseId === binding.jobLeaseId &&
    request.branchLeaseId === binding.branchLeaseId &&
    request.approvalFingerprint === binding.approvalFingerprint &&
    request.canonicalBranch === binding.canonicalBranch
  );
}

function sameOperation(
  operation: CheckpointOperation,
  request: CheckpointRequest,
): boolean {
  return (
    operation.expectedOid === request.expectedOid &&
    operation.headOid === request.headOid
  );
}

function accepted(
  requestId: string,
  operationId: string,
): CheckpointAcceptedEvent {
  return { type: "checkpoint.accepted", requestId, operationId };
}

function completed(operation: CheckpointOperation): CheckpointCompletedEvent {
  return {
    type: "checkpoint.completed",
    requestId: operation.requestId,
    operationId: operation.operationId,
    canonicalOid: operation.canonicalOid ?? operation.headOid,
  };
}

function rejected(
  requestId: string,
  reason: CheckpointRejectedEvent["reason"],
): CheckpointRejectedEvent {
  return { type: "checkpoint.rejected", requestId, reason };
}
