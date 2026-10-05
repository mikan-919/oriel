import * as v from "valibot";

import {
  checkpointAcceptedEventSchema,
  checkpointCompletedEventSchema,
  checkpointRejectedEventSchema,
  checkpointRequestSchema,
  stopRequestSchema,
} from "./implementation";
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
 * PR対応workerが受け取るtriggerの内容。
 *
 * [ADR 0007](../../../docs/adr/0007-pull-request-response-job.md)のとおり、
 * どれか一つだけを渡す。CIの生ログは含めない。
 */
export const prResponseTriggerSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("review"),
    body: v.string(),
    comments: v.array(
      v.strictObject({
        path: v.string(),
        line: v.nullable(v.pipe(v.number(), v.integer())),
        body: nonEmptyString,
      }),
    ),
  }),
  v.strictObject({
    kind: v.literal("comment"),
    comments: v.array(v.strictObject({ body: nonEmptyString })),
  }),
  v.strictObject({
    kind: v.literal("check_failure"),
    checkName: nonEmptyString,
    conclusion: nonEmptyString,
    summary: v.string(),
  }),
]);

export type PrResponseTrigger = v.InferOutput<typeof prResponseTriggerSchema>;

/**
 * PR対応workerのIPC。
 *
 * `serve`はcredentialを渡さず、既に開いているPull Requestのcanonicalブランチ
 * worktreeと、triggerとなったreview/comment/check failureの内容だけを渡す。
 * harnessは実装Jobと同じworktree toolだけを使い、PR操作toolを持たない。
 */
export const prResponseStartEventSchema = v.strictObject({
  type: v.literal("pr_response.start"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  branchLeaseId: nonEmptyString,
  approvalFingerprint,
  canonicalBranch: nonEmptyString,
  canonicalOid: objectId,
  worktreePath: nonEmptyString,
  worktreeOid: objectId,
  prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  model: v.strictObject({ provider: nonEmptyString, id: nonEmptyString }),
  trigger: prResponseTriggerSchema,
  /** worktree内で順に実行する検証command。取り込み先branchの設定だけを正本とする。 */
  verification: v.array(v.pipe(v.array(nonEmptyString), v.minLength(1))),
});

export type PrResponseStartEvent = v.InferOutput<
  typeof prResponseStartEventSchema
>;

/**
 * PR対応workerの明示的な結果。`serve`はharness processの終了だけでJobの完了を
 * 決めない。
 */
export const prResponseResultSchema = v.strictObject({
  type: v.literal("pr_response.result"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  stopReason: nonEmptyString,
  acted: v.boolean(),
  sourceChanged: v.boolean(),
  verified: v.boolean(),
});

export type PrResponseResult = v.InferOutput<typeof prResponseResultSchema>;

export const prResponseServerMessageSchema = v.variant("type", [
  prResponseStartEventSchema,
  checkpointAcceptedEventSchema,
  checkpointCompletedEventSchema,
  checkpointRejectedEventSchema,
  stopRequestSchema,
  modelStreamEventSchema,
  modelStreamEndSchema,
  modelStreamRejectedSchema,
]);

export type PrResponseServerMessage = v.InferOutput<
  typeof prResponseServerMessageSchema
>;

/**
 * harnessから`serve`へ流すmessage。用途限定の外部操作要求だけとする。
 *
 * 収束しなかった場合の報告commentは、worker終了後に`serve`自身が
 * `issue-comments.ts`のIssue comment操作(PRも同じComment APIを使う)で投稿する。
 * harnessはPR上へcommentするtoolを持たない。
 */
export const prResponseClientMessageSchema = v.variant("type", [
  checkpointRequestSchema,
  prResponseResultSchema,
  modelStreamRequestSchema,
  modelStreamAbortSchema,
]);

export type PrResponseClientMessage = v.InferOutput<
  typeof prResponseClientMessageSchema
>;

export function parsePrResponseStartEvent(
  value: unknown,
): PrResponseStartEvent {
  return v.parse(prResponseStartEventSchema, value);
}

export function parsePrResponseServerMessage(
  value: unknown,
): PrResponseServerMessage {
  return v.parse(prResponseServerMessageSchema, value);
}

export function parsePrResponseClientMessage(
  value: unknown,
): PrResponseClientMessage {
  return v.parse(prResponseClientMessageSchema, value);
}
