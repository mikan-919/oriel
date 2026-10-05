import * as v from "valibot";

import {
  modelStreamAbortSchema,
  modelStreamEndSchema,
  modelStreamEventSchema,
  modelStreamRejectedSchema,
  modelStreamRequestSchema,
} from "./model-stream";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const objectId = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));
const approvalFingerprint = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

/**
 * 実装workerのIPC。
 *
 * `serve`はcredentialを渡さず、封印済みcanonicalブランチのworktreeと、承認済みの
 * WHAT/HOWだけをharnessへ渡す。harnessはworktree内の編集、build、test、commitを
 * 自分で行い、外部への送信は`serve`の用途限定操作としてだけ要求する。
 */
export const implementationStartEventSchema = v.strictObject({
  type: v.literal("implementation.start"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  branchLeaseId: nonEmptyString,
  approvalFingerprint,
  /** 封印済みcanonicalブランチと、遠隔にある現在の先端。 */
  canonicalBranch: nonEmptyString,
  canonicalOid: objectId,
  worktreePath: nonEmptyString,
  /**
   * worktreeの現在の先端。引き継ぎで最新の取り込み先を統合した場合、遠隔の
   * `canonicalOid`より進む。harnessはこの先端から検証をやり直す。
   */
  worktreeOid: objectId,
  /** 既存ブランチの引き継ぎでは、先端を未検証の作業途中成果として扱う。 */
  adopted: v.boolean(),
  /**
   * `serve`が選んだ提供元とmodelの論理識別子。接続先、認証情報、互換性設定は
   * `serve`が正本として持ち、harnessへは渡さない。
   */
  model: v.strictObject({ provider: nonEmptyString, id: nonEmptyString }),
  what: v.strictObject({ title: nonEmptyString, body: v.string() }),
  how: v.strictObject({ title: nonEmptyString, description: v.string() }),
  /**
   * worktree内で順に実行する検証command。shell文字列ではなく引数配列で渡す。
   * 引き継いだ先端は未検証の作業途中成果のため、workerはこれを最初からやり直す。
   */
  verification: v.array(v.pipe(v.array(nonEmptyString), v.minLength(1))),
});

export type ImplementationStartEvent = v.InferOutput<
  typeof implementationStartEventSchema
>;

/** checkpointの送信要求。送信前OIDを比較条件として`serve`へ渡す。 */
export const checkpointRequestSchema = v.strictObject({
  type: v.literal("checkpoint.request"),
  requestId: nonEmptyString,
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  branchLeaseId: nonEmptyString,
  approvalFingerprint,
  canonicalBranch: nonEmptyString,
  expectedOid: objectId,
  headOid: objectId,
  /** 未検証のWIP checkpointかどうか。 */
  verified: v.boolean(),
});

export type CheckpointRequest = v.InferOutput<typeof checkpointRequestSchema>;

export const checkpointAcceptedEventSchema = v.strictObject({
  type: v.literal("checkpoint.accepted"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
});

export type CheckpointAcceptedEvent = v.InferOutput<
  typeof checkpointAcceptedEventSchema
>;

export const checkpointCompletedEventSchema = v.strictObject({
  type: v.literal("checkpoint.completed"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
  canonicalOid: objectId,
});

export type CheckpointCompletedEvent = v.InferOutput<
  typeof checkpointCompletedEventSchema
>;

export const checkpointRejectedEventSchema = v.strictObject({
  type: v.literal("checkpoint.rejected"),
  requestId: nonEmptyString,
  reason: v.picklist([
    "invalid_request",
    "ownership_not_current",
    /** 現在値から承認対象が変わったと確定した。 */
    "target_mismatch",
    /** 承認対象を読めず、変わったかどうかを決められない。 */
    "approval_state_unknown",
    "remote_diverged",
    "push_failed",
  ]),
});

export type CheckpointRejectedEvent = v.InferOutput<
  typeof checkpointRejectedEventSchema
>;

/**
 * Web UIからの計画停止要求。
 *
 * CONCEPT.mdのとおり、harnessはAgent loopの現在のturnを安全に区切ってから
 * checkpointをpushする。接続所有権喪失時の即時abortとは別の、明示的な要求。
 */
export const stopRequestSchema = v.strictObject({
  type: v.literal("stop.request"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
});

export type StopRequest = v.InferOutput<typeof stopRequestSchema>;

export const checkpointEventSchema = v.variant("type", [
  checkpointAcceptedEventSchema,
  checkpointCompletedEventSchema,
  checkpointRejectedEventSchema,
]);

export type CheckpointEvent = v.InferOutput<typeof checkpointEventSchema>;

/**
 * 実装workerの明示的な結果。
 *
 * `serve`はharnessのprocess終了だけでJobの完了を決めない。Agent loopがsourceを
 * 実際に編集したか、設定由来の検証を通したか、どの理由で止まったかをharnessが
 * 明示し、`serve`がJobを`completed`にしてよいかを判断する。WHAT/HOWの本文や
 * 会話は載せない。
 */
export const implementationResultSchema = v.strictObject({
  type: v.literal("implementation.result"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  /** 最後のassistant turnの停止理由。`error`と`aborted`は未完了とする。 */
  stopReason: nonEmptyString,
  /** Agent loopがtoolを実行したか。 */
  acted: v.boolean(),
  /** Agent loopがworktree内のsourceを実際に変えたか。 */
  sourceChanged: v.boolean(),
  /** 設定由来の検証commandをすべて通したか。 */
  verified: v.boolean(),
});

export type ImplementationResult = v.InferOutput<
  typeof implementationResultSchema
>;

/** `serve`からharnessへ流すmessage。 */
export const implementationServerMessageSchema = v.variant("type", [
  implementationStartEventSchema,
  checkpointAcceptedEventSchema,
  checkpointCompletedEventSchema,
  checkpointRejectedEventSchema,
  stopRequestSchema,
  modelStreamEventSchema,
  modelStreamEndSchema,
  modelStreamRejectedSchema,
]);

export type ImplementationServerMessage = v.InferOutput<
  typeof implementationServerMessageSchema
>;

/** harnessから`serve`へ流すmessage。用途限定の外部操作要求だけとする。 */
export const implementationClientMessageSchema = v.variant("type", [
  checkpointRequestSchema,
  implementationResultSchema,
  modelStreamRequestSchema,
  modelStreamAbortSchema,
]);

export type ImplementationClientMessage = v.InferOutput<
  typeof implementationClientMessageSchema
>;

export function parseImplementationStartEvent(
  value: unknown,
): ImplementationStartEvent {
  return v.parse(implementationStartEventSchema, value);
}

export function parseCheckpointRequest(value: unknown): CheckpointRequest {
  return v.parse(checkpointRequestSchema, value);
}

export function parseCheckpointEvent(value: unknown): CheckpointEvent {
  return v.parse(checkpointEventSchema, value);
}

export function parseImplementationServerMessage(
  value: unknown,
): ImplementationServerMessage {
  return v.parse(implementationServerMessageSchema, value);
}

export function parseImplementationClientMessage(
  value: unknown,
): ImplementationClientMessage {
  return v.parse(implementationClientMessageSchema, value);
}
