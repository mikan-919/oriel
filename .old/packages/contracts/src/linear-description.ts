import * as v from "valibot";

import { githubRepositorySchema } from "./github";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * Linear issue descriptionの置き換え要求。
 *
 * `baselineDescription`はharnessがturn開始時に読んだ現在値。書き込み直前に
 * 再読した現在値と一致しない場合は人間の同時変更とみなし、`concurrent_change`
 * で拒否する。汎用mergeは行わず、常にfail closedにする。
 */
export const linearDescriptionUpdateRequestSchema = v.strictObject({
  type: v.literal("linear_description.request"),
  requestId: nonEmptyString,
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  repository: githubRepositorySchema,
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  linearIssueId: nonEmptyString,
  description: nonEmptyString,
  baselineDescription: v.string(),
});

export type LinearDescriptionUpdateRequest = v.InferOutput<
  typeof linearDescriptionUpdateRequestSchema
>;

export const linearDescriptionUpdateCompletedEventSchema = v.strictObject({
  type: v.literal("linear_description.completed"),
  requestId: nonEmptyString,
});

export type LinearDescriptionUpdateCompletedEvent = v.InferOutput<
  typeof linearDescriptionUpdateCompletedEventSchema
>;

export const linearDescriptionUpdateRejectedEventSchema = v.strictObject({
  type: v.literal("linear_description.rejected"),
  requestId: nonEmptyString,
  reason: v.picklist([
    "invalid_request",
    "ownership_not_current",
    "target_mismatch",
    "concurrent_change",
    "linear_rejected",
  ]),
});

export type LinearDescriptionUpdateRejectedEvent = v.InferOutput<
  typeof linearDescriptionUpdateRejectedEventSchema
>;

export const linearDescriptionUpdateEventSchema = v.variant("type", [
  linearDescriptionUpdateCompletedEventSchema,
  linearDescriptionUpdateRejectedEventSchema,
]);

export type LinearDescriptionUpdateEvent = v.InferOutput<
  typeof linearDescriptionUpdateEventSchema
>;

export function parseLinearDescriptionUpdateRequest(
  value: unknown,
): LinearDescriptionUpdateRequest {
  return v.parse(linearDescriptionUpdateRequestSchema, value);
}

export function parseLinearDescriptionUpdateEvent(
  value: unknown,
): LinearDescriptionUpdateEvent {
  return v.parse(linearDescriptionUpdateEventSchema, value);
}
