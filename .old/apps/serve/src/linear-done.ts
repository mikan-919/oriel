import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";

import { doneStateName } from "./linear-approval";

/** Done反映だけに使う境界。credentialは`serve`が持つ。 */
export interface LinearDonePorts {
  readLinearState(linearIssueId: string): Promise<string | null>;
  moveToDone(linearIssueId: string): Promise<boolean>;
}

export type ReflectDoneStateStatus =
  /** 現在値がDoneになった。もともとDoneだった場合を含む。 */
  | "done"
  | "state_unknown"
  /** 送信したが現在値がDoneのまま反映を確認できない。結果不明として扱う。 */
  | "still_open";

/**
 * mergeを現在値から確認した後のDone反映の操作記録。
 */
export function createLinearDoneOutbox(database: Database) {
  const insert = database.query(
    `INSERT INTO linear_done_outbox (
      attempt_id, job_id, linear_issue_id, operation, status
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  const update = database.query(
    `UPDATE linear_done_outbox SET status = ? WHERE attempt_id = ?`,
  );

  return {
    start(attempt: {
      attemptId: string;
      jobId: string;
      linearIssueId: string;
    }) {
      insert.run(
        attempt.attemptId,
        attempt.jobId,
        attempt.linearIssueId,
        "move-to-done",
        "pending",
      );
    },
    settle(attemptId: string, status: ReflectDoneStateStatus) {
      update.run(status, attemptId);
    },
  };
}

export interface ReflectDoneStateOptions {
  database: Database;
  ports: LinearDonePorts;
  target: { jobId: string; linearIssueId: string };
  newAttemptId?: () => string;
}

/**
 * merge確認後のLinear Done反映。
 *
 * ADR 0005「Linear状態」のとおり、mergeは実装Jobの接続所有権が解けた後に
 * 確認するため、他の反映と違いJob所有権接続の確認は行わない。ローカル`serve`は
 * repository単位で一つだけのため、複数`serve`の競合を心配する必要もない。
 * mergeという確定的な外部事実を受けて、現在stateに関わらずDoneへ収束させる。
 */
export async function reflectDoneState({
  database,
  ports,
  target,
  newAttemptId = randomUUID,
}: ReflectDoneStateOptions): Promise<ReflectDoneStateStatus> {
  const before = await ports
    .readLinearState(target.linearIssueId)
    .catch(() => null);

  if (before === null) {
    return "state_unknown";
  }

  if (before === doneStateName) {
    return "done";
  }

  const outbox = createLinearDoneOutbox(database);
  const attemptId = newAttemptId();

  outbox.start({
    attemptId,
    jobId: target.jobId,
    linearIssueId: target.linearIssueId,
  });

  await ports.moveToDone(target.linearIssueId).catch(() => false);

  const after = await ports
    .readLinearState(target.linearIssueId)
    .catch(() => null);
  const status: ReflectDoneStateStatus =
    after === doneStateName ? "done" : "still_open";

  outbox.settle(attemptId, status);

  return status;
}
