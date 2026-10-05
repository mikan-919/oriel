import * as v from "valibot";

import { githubRepositorySchema } from "./github";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const issueCommentRequestSchema = v.strictObject({
  type: v.literal("issue_comment.request"),
  requestId: nonEmptyString,
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  repository: githubRepositorySchema,
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  body: nonEmptyString,
});

export type IssueCommentRequest = v.InferOutput<
  typeof issueCommentRequestSchema
>;

export const issueCommentAcceptedEventSchema = v.strictObject({
  type: v.literal("issue_comment.accepted"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
});

export type IssueCommentAcceptedEvent = v.InferOutput<
  typeof issueCommentAcceptedEventSchema
>;

export const issueCommentCompletedEventSchema = v.strictObject({
  type: v.literal("issue_comment.completed"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
  githubCommentId: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type IssueCommentCompletedEvent = v.InferOutput<
  typeof issueCommentCompletedEventSchema
>;

export const issueCommentRejectedEventSchema = v.strictObject({
  type: v.literal("issue_comment.rejected"),
  requestId: nonEmptyString,
  operationId: v.optional(nonEmptyString),
  reason: v.picklist([
    "invalid_request",
    "ownership_not_current",
    "request_conflict",
    "github_rejected",
    "target_mismatch",
  ]),
});

export type IssueCommentRejectedEvent = v.InferOutput<
  typeof issueCommentRejectedEventSchema
>;

export const issueCommentReconciliationRequiredEventSchema = v.strictObject({
  type: v.literal("issue_comment.reconciliation_required"),
  requestId: nonEmptyString,
  operationId: nonEmptyString,
});

export type IssueCommentReconciliationRequiredEvent = v.InferOutput<
  typeof issueCommentReconciliationRequiredEventSchema
>;

export const issueCommentEventSchema = v.variant("type", [
  issueCommentAcceptedEventSchema,
  issueCommentCompletedEventSchema,
  issueCommentRejectedEventSchema,
  issueCommentReconciliationRequiredEventSchema,
]);

export type IssueCommentEvent = v.InferOutput<typeof issueCommentEventSchema>;

export function parseIssueCommentRequest(value: unknown): IssueCommentRequest {
  return v.parse(issueCommentRequestSchema, value);
}

export function parseIssueCommentAcceptedEvent(
  value: unknown,
): IssueCommentAcceptedEvent {
  return v.parse(issueCommentAcceptedEventSchema, value);
}

export function parseIssueCommentCompletedEvent(
  value: unknown,
): IssueCommentCompletedEvent {
  return v.parse(issueCommentCompletedEventSchema, value);
}

export function parseIssueCommentEvent(value: unknown): IssueCommentEvent {
  return v.parse(issueCommentEventSchema, value);
}
