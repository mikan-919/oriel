import * as v from "valibot";

import { githubRepositorySchema } from "./github";
import {
  issueBodyUpdateCompletedEventSchema,
  issueBodyUpdateRejectedEventSchema,
  issueBodyUpdateRequestSchema,
} from "./issue-body";
import {
  issueCommentAcceptedEventSchema,
  issueCommentCompletedEventSchema,
  issueCommentRejectedEventSchema,
  issueCommentReconciliationRequiredEventSchema,
  issueCommentRequestSchema,
} from "./issue-comment";
import {
  linearTriageLinkCompletedEventSchema,
  linearTriageLinkRejectedEventSchema,
  linearTriageLinkRequestSchema,
} from "./linear-triage-link";
import {
  modelStreamAbortSchema,
  modelStreamEndSchema,
  modelStreamEventSchema,
  modelStreamRejectedSchema,
  modelStreamRequestSchema,
} from "./model-stream";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * WHAT確定workerのIPC。
 *
 * Issue #33のとおり、`serve`はcredentialを渡さず、起動時点のGitHub Issueと
 * commentの現在値、トリガーとなったcommentだけをharnessへ渡す。harnessはこの
 * 一回のcheckを判断材料にし、Linearへの作成・紐付けはtrigger.commandがtrueの
 * 時だけ要求できる(toolの提供そのものを`serve`側で絞る)。
 */
export const whatConfirmationStartEventSchema = v.strictObject({
  type: v.literal("what_confirmation.start"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  repository: githubRepositorySchema,
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  model: v.strictObject({ provider: nonEmptyString, id: nonEmptyString }),
  issue: v.strictObject({ title: nonEmptyString, body: v.string() }),
  comments: v.array(
    v.strictObject({
      id: v.pipe(v.number(), v.integer(), v.minValue(1)),
      authorLogin: v.string(),
      body: v.string(),
    }),
  ),
  trigger: v.strictObject({
    commentId: v.pipe(v.number(), v.integer(), v.minValue(1)),
    /** `/oriel confirm`のような明示的な指示か、単なるmentionか。 */
    command: v.boolean(),
  }),
});

export type WhatConfirmationStartEvent = v.InferOutput<
  typeof whatConfirmationStartEventSchema
>;

/**
 * WHAT確定workerの明示的な結果。`serve`はharness processの終了だけでJobの完了を
 * 決めない。
 */
export const whatConfirmationResultSchema = v.strictObject({
  type: v.literal("what_confirmation.result"),
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  stopReason: nonEmptyString,
  acted: v.boolean(),
});

export type WhatConfirmationResult = v.InferOutput<
  typeof whatConfirmationResultSchema
>;

export const whatConfirmationServerMessageSchema = v.variant("type", [
  whatConfirmationStartEventSchema,
  issueCommentAcceptedEventSchema,
  issueCommentCompletedEventSchema,
  issueCommentRejectedEventSchema,
  issueCommentReconciliationRequiredEventSchema,
  issueBodyUpdateCompletedEventSchema,
  issueBodyUpdateRejectedEventSchema,
  linearTriageLinkCompletedEventSchema,
  linearTriageLinkRejectedEventSchema,
  modelStreamEventSchema,
  modelStreamEndSchema,
  modelStreamRejectedSchema,
]);

export type WhatConfirmationServerMessage = v.InferOutput<
  typeof whatConfirmationServerMessageSchema
>;

export const whatConfirmationClientMessageSchema = v.variant("type", [
  issueCommentRequestSchema,
  issueBodyUpdateRequestSchema,
  linearTriageLinkRequestSchema,
  whatConfirmationResultSchema,
  modelStreamRequestSchema,
  modelStreamAbortSchema,
]);

export type WhatConfirmationClientMessage = v.InferOutput<
  typeof whatConfirmationClientMessageSchema
>;

export function parseWhatConfirmationStartEvent(
  value: unknown,
): WhatConfirmationStartEvent {
  return v.parse(whatConfirmationStartEventSchema, value);
}

export function parseWhatConfirmationServerMessage(
  value: unknown,
): WhatConfirmationServerMessage {
  return v.parse(whatConfirmationServerMessageSchema, value);
}

export function parseWhatConfirmationClientMessage(
  value: unknown,
): WhatConfirmationClientMessage {
  return v.parse(whatConfirmationClientMessageSchema, value);
}
