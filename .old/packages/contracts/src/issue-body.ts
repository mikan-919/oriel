import * as v from "valibot";

import { githubRepositorySchema } from "./github";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * GitHub Issue本文の置き換え要求。
 *
 * commentの追記(`issue_comment.request`)とは別に扱う。ADR 0003のとおりcomment
 * を仕様の正本にはせず、確定したWHATだけをIssue本文へ反映する。
 */
export const issueBodyUpdateRequestSchema = v.strictObject({
  type: v.literal("issue_body.request"),
  requestId: nonEmptyString,
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  repository: githubRepositorySchema,
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  body: nonEmptyString,
});

export type IssueBodyUpdateRequest = v.InferOutput<
  typeof issueBodyUpdateRequestSchema
>;

export const issueBodyUpdateCompletedEventSchema = v.strictObject({
  type: v.literal("issue_body.completed"),
  requestId: nonEmptyString,
});

export type IssueBodyUpdateCompletedEvent = v.InferOutput<
  typeof issueBodyUpdateCompletedEventSchema
>;

export const issueBodyUpdateRejectedEventSchema = v.strictObject({
  type: v.literal("issue_body.rejected"),
  requestId: nonEmptyString,
  reason: v.picklist([
    "invalid_request",
    "ownership_not_current",
    "target_mismatch",
    "github_rejected",
  ]),
});

export type IssueBodyUpdateRejectedEvent = v.InferOutput<
  typeof issueBodyUpdateRejectedEventSchema
>;

export const issueBodyUpdateEventSchema = v.variant("type", [
  issueBodyUpdateCompletedEventSchema,
  issueBodyUpdateRejectedEventSchema,
]);

export type IssueBodyUpdateEvent = v.InferOutput<
  typeof issueBodyUpdateEventSchema
>;

export function parseIssueBodyUpdateRequest(
  value: unknown,
): IssueBodyUpdateRequest {
  return v.parse(issueBodyUpdateRequestSchema, value);
}

export function parseIssueBodyUpdateEvent(
  value: unknown,
): IssueBodyUpdateEvent {
  return v.parse(issueBodyUpdateEventSchema, value);
}
