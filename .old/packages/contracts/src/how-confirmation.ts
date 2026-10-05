import * as v from "valibot";

import { githubRepositorySchema } from "./github";
import {
  linearCommentAcceptedEventSchema,
  linearCommentCompletedEventSchema,
  linearCommentRejectedEventSchema,
  linearCommentReconciliationRequiredEventSchema,
  linearCommentRequestSchema,
} from "./linear-comment";
import {
  linearDescriptionUpdateCompletedEventSchema,
  linearDescriptionUpdateRejectedEventSchema,
  linearDescriptionUpdateRequestSchema,
} from "./linear-description";
import {
  modelStreamAbortSchema,
  modelStreamEndSchema,
  modelStreamEventSchema,
  modelStreamRejectedSchema,
  modelStreamRequestSchema,
} from "./model-stream";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * HOW確定workerのIPC。
 *
 * Issue #34のとおり、`serve`はcredentialを渡さず、起動時点のLinear issueと
 * commentの現在値、トリガーとなったcommentだけをharnessへ渡す。harnessは
 * Linearのstateを変更する手段を一切持たない(Triage→Todoは常に人間だけが行う)。
 */
export const howConfirmationStartEventSchema = v.strictObject({
  type: v.literal("how_confirmation.start"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  repository: githubRepositorySchema,
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  linearIssueId: nonEmptyString,
  model: v.strictObject({ provider: nonEmptyString, id: nonEmptyString }),
  linearIssue: v.strictObject({
    title: nonEmptyString,
    description: v.string(),
  }),
  comments: v.array(
    v.strictObject({
      id: nonEmptyString,
      authorIsActor: v.boolean(),
      body: v.string(),
    }),
  ),
  trigger: v.strictObject({
    commentId: nonEmptyString,
    /** `/oriel confirm`のような明示的な指示か、単なるmentionか。 */
    command: v.boolean(),
  }),
});

export type HowConfirmationStartEvent = v.InferOutput<
  typeof howConfirmationStartEventSchema
>;

/**
 * HOW確定workerの明示的な結果。`serve`はharness processの終了だけでJobの完了を
 * 決めない。
 */
export const howConfirmationResultSchema = v.strictObject({
  type: v.literal("how_confirmation.result"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  stopReason: nonEmptyString,
  acted: v.boolean(),
});

export type HowConfirmationResult = v.InferOutput<
  typeof howConfirmationResultSchema
>;

export const howConfirmationServerMessageSchema = v.variant("type", [
  howConfirmationStartEventSchema,
  linearCommentAcceptedEventSchema,
  linearCommentCompletedEventSchema,
  linearCommentRejectedEventSchema,
  linearCommentReconciliationRequiredEventSchema,
  linearDescriptionUpdateCompletedEventSchema,
  linearDescriptionUpdateRejectedEventSchema,
  modelStreamEventSchema,
  modelStreamEndSchema,
  modelStreamRejectedSchema,
]);

export type HowConfirmationServerMessage = v.InferOutput<
  typeof howConfirmationServerMessageSchema
>;

export const howConfirmationClientMessageSchema = v.variant("type", [
  linearCommentRequestSchema,
  linearDescriptionUpdateRequestSchema,
  howConfirmationResultSchema,
  modelStreamRequestSchema,
  modelStreamAbortSchema,
]);

export type HowConfirmationClientMessage = v.InferOutput<
  typeof howConfirmationClientMessageSchema
>;

export function parseHowConfirmationStartEvent(
  value: unknown,
): HowConfirmationStartEvent {
  return v.parse(howConfirmationStartEventSchema, value);
}

export function parseHowConfirmationServerMessage(
  value: unknown,
): HowConfirmationServerMessage {
  return v.parse(howConfirmationServerMessageSchema, value);
}

export function parseHowConfirmationClientMessage(
  value: unknown,
): HowConfirmationClientMessage {
  return v.parse(howConfirmationClientMessageSchema, value);
}
