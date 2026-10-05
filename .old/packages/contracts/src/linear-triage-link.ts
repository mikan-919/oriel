import * as v from "valibot";

import { githubRepositorySchema } from "./github";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * GitHub IssueをLinear issueへ結び付ける要求。
 *
 * 対応するLinear issueが無い場合だけTriageで新規作成し、GitHub Issue URLの
 * attachmentで一意に結び付ける。既に一件だけ結び付いていれば作成せず、その
 * issue IDをそのまま返す(冪等)。複数結び付いていれば`ambiguous_existing_link`
 * で止め、選ばない。
 */
export const linearTriageLinkRequestSchema = v.strictObject({
  type: v.literal("linear_triage_link.request"),
  requestId: nonEmptyString,
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  repository: githubRepositorySchema,
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: nonEmptyString,
  description: v.string(),
});

export type LinearTriageLinkRequest = v.InferOutput<
  typeof linearTriageLinkRequestSchema
>;

export const linearTriageLinkCompletedEventSchema = v.strictObject({
  type: v.literal("linear_triage_link.completed"),
  requestId: nonEmptyString,
  linearIssueId: nonEmptyString,
});

export type LinearTriageLinkCompletedEvent = v.InferOutput<
  typeof linearTriageLinkCompletedEventSchema
>;

export const linearTriageLinkRejectedEventSchema = v.strictObject({
  type: v.literal("linear_triage_link.rejected"),
  requestId: nonEmptyString,
  reason: v.picklist([
    "invalid_request",
    "ownership_not_current",
    "target_mismatch",
    "ambiguous_existing_link",
    "linear_rejected",
  ]),
});

export type LinearTriageLinkRejectedEvent = v.InferOutput<
  typeof linearTriageLinkRejectedEventSchema
>;

export const linearTriageLinkEventSchema = v.variant("type", [
  linearTriageLinkCompletedEventSchema,
  linearTriageLinkRejectedEventSchema,
]);

export type LinearTriageLinkEvent = v.InferOutput<
  typeof linearTriageLinkEventSchema
>;

export function parseLinearTriageLinkRequest(
  value: unknown,
): LinearTriageLinkRequest {
  return v.parse(linearTriageLinkRequestSchema, value);
}

export function parseLinearTriageLinkEvent(
  value: unknown,
): LinearTriageLinkEvent {
  return v.parse(linearTriageLinkEventSchema, value);
}
