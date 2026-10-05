import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * transcript検索の要求。
 *
 * ROADMAPの「local、current Job、repositoryの範囲」のうち、`job`と`local`は
 * 要求元の`serve`が自分のSQLiteだけで完結させる。`repository`だけがrelayの
 * notification channelへ載り、同じrepositoryを担当する接続中の他の`serve`へ
 * 中継される。relayはqueryと結果を保存せず、中継するだけ。
 */
export const transcriptSearchRequestSchema = v.strictObject({
  type: v.literal("transcript.search.request"),
  requestId: nonEmptyString,
  scope: v.picklist(["job", "local", "repository"]),
  jobId: v.optional(nonEmptyString),
  query: nonEmptyString,
  limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)),
});

export type TranscriptSearchRequest = v.InferOutput<
  typeof transcriptSearchRequestSchema
>;

export const transcriptEntrySchema = v.strictObject({
  jobId: nonEmptyString,
  sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
  kind: nonEmptyString,
  content: v.string(),
  createdAt: v.number(),
});

export type TranscriptEntry = v.InferOutput<typeof transcriptEntrySchema>;

export const transcriptSearchResultSchema = v.strictObject({
  type: v.literal("transcript.search.result"),
  requestId: nonEmptyString,
  entries: v.array(transcriptEntrySchema),
});

export type TranscriptSearchResult = v.InferOutput<
  typeof transcriptSearchResultSchema
>;

/** notification channel上を双方向に流れるtranscript検索message。 */
export const transcriptRelayMessageSchema = v.variant("type", [
  transcriptSearchRequestSchema,
  transcriptSearchResultSchema,
]);

export type TranscriptRelayMessage = v.InferOutput<
  typeof transcriptRelayMessageSchema
>;

export function parseTranscriptRelayMessage(
  value: unknown,
): TranscriptRelayMessage {
  return v.parse(transcriptRelayMessageSchema, value);
}
