import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * modelへの要求と応答を運ぶIPC。
 *
 * ROADMAPの「Agentとモデル提供元」のとおり、Agent loopは認証情報を持たない実行
 * ハーネスで動き、提供元への接続、認証情報の解決、モデル選択は信頼された`serve`
 * が担う。実行ハーネスが指定できるのは論理的な提供元IDとmodel IDだけとし、
 * 接続先、認証情報、互換性設定の正本は`serve`に置く。
 *
 * IPCは要求の対応付け、event配送、中止、切断検知だけを加える。provider event
 * そのものは`event`としてreshapeせずに運ぶ。
 */
export const modelStreamRequestSchema = v.strictObject({
  type: v.literal("model.stream.request"),
  requestId: nonEmptyString,
  jobId: nonEmptyString,
  jobLeaseId: nonEmptyString,
  /** `serve`が選び、start eventで渡した論理識別子と一致しなければならない。 */
  provider: nonEmptyString,
  model: nonEmptyString,
  /** Agent loopが組み立てた要求内容。`serve`は別形式へ変換しない。 */
  context: v.unknown(),
});

export type ModelStreamRequest = v.InferOutput<typeof modelStreamRequestSchema>;

/** 進行中の要求の中止。callbackやAbortSignalそのものは送らない。 */
export const modelStreamAbortSchema = v.strictObject({
  type: v.literal("model.stream.abort"),
  requestId: nonEmptyString,
});

export type ModelStreamAbort = v.InferOutput<typeof modelStreamAbortSchema>;

export const modelStreamEventSchema = v.strictObject({
  type: v.literal("model.stream.event"),
  requestId: nonEmptyString,
  event: v.unknown(),
});

export type ModelStreamEvent = v.InferOutput<typeof modelStreamEventSchema>;

export const modelStreamEndSchema = v.strictObject({
  type: v.literal("model.stream.end"),
  requestId: nonEmptyString,
});

export type ModelStreamEnd = v.InferOutput<typeof modelStreamEndSchema>;

export const modelStreamRejectedSchema = v.strictObject({
  type: v.literal("model.stream.rejected"),
  requestId: nonEmptyString,
  reason: v.picklist([
    "invalid_request",
    "ownership_not_current",
    "target_mismatch",
    /** modelを利用できない。別のmodelへ暗黙に切り替えず止める。 */
    "model_unavailable",
  ]),
});

export type ModelStreamRejected = v.InferOutput<
  typeof modelStreamRejectedSchema
>;

export const modelStreamServerMessageSchema = v.variant("type", [
  modelStreamEventSchema,
  modelStreamEndSchema,
  modelStreamRejectedSchema,
]);

export type ModelStreamServerMessage = v.InferOutput<
  typeof modelStreamServerMessageSchema
>;

export function parseModelStreamRequest(value: unknown): ModelStreamRequest {
  return v.parse(modelStreamRequestSchema, value);
}

export function parseModelStreamServerMessage(
  value: unknown,
): ModelStreamServerMessage {
  return v.parse(modelStreamServerMessageSchema, value);
}
