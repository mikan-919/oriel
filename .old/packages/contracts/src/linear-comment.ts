import * as v from "valibot";

import { githubRepositorySchema } from "./github";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * Linear issueへのcomment投稿要求。
 *
 * Job所有権はissue-comment.tsと同じくGitHub repository・issueNumberで確認する
 * (ADR 0002の所有権チャンネルはWorkflow=GitHub Issue単位)。書き込み先だけが
 * `linearIssueId`で指定するLinear issueになる。
 */
export const linearCommentRequestSchema = v.strictObject({
  type: v.literal("linear_comment.request"),
  requestId: nonEmptyString,
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  repository: githubRepositorySchema,
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  linearIssueId: nonEmptyString,
  body: nonEmptyString,
});

export type LinearCommentRequest = v.InferOutput<
  typeof linearCommentRequestSchema
>;

export const linearCommentAcceptedEventSchema = v.strictObject({
  type: v.literal("linear_comment.accepted"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
});

export type LinearCommentAcceptedEvent = v.InferOutput<
  typeof linearCommentAcceptedEventSchema
>;

export const linearCommentCompletedEventSchema = v.strictObject({
  type: v.literal("linear_comment.completed"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
  linearCommentId: nonEmptyString,
});

export type LinearCommentCompletedEvent = v.InferOutput<
  typeof linearCommentCompletedEventSchema
>;

export const linearCommentRejectedEventSchema = v.strictObject({
  type: v.literal("linear_comment.rejected"),
  requestId: nonEmptyString,
  operationId: v.optional(nonEmptyString),
  reason: v.picklist([
    "invalid_request",
    "ownership_not_current",
    "request_conflict",
    "linear_rejected",
    "target_mismatch",
  ]),
});

export type LinearCommentRejectedEvent = v.InferOutput<
  typeof linearCommentRejectedEventSchema
>;

export const linearCommentReconciliationRequiredEventSchema = v.strictObject({
  type: v.literal("linear_comment.reconciliation_required"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
});

export type LinearCommentReconciliationRequiredEvent = v.InferOutput<
  typeof linearCommentReconciliationRequiredEventSchema
>;

export const linearCommentEventSchema = v.variant("type", [
  linearCommentAcceptedEventSchema,
  linearCommentCompletedEventSchema,
  linearCommentRejectedEventSchema,
  linearCommentReconciliationRequiredEventSchema,
]);

export type LinearCommentEvent = v.InferOutput<typeof linearCommentEventSchema>;

export function parseLinearCommentRequest(
  value: unknown,
): LinearCommentRequest {
  return v.parse(linearCommentRequestSchema, value);
}

export function parseLinearCommentEvent(value: unknown): LinearCommentEvent {
  return v.parse(linearCommentEventSchema, value);
}
