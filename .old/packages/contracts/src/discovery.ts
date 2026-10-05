import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * relay→serveの起床通知。
 *
 * ADR 0001のとおりwebhookは起床通知であり正本ではない。webhookのpayload内容
 * (title、body、state名など)は一切含めず、「このrepositoryで何か変わったかも
 * しれない」という最小限の合図だけを送る。`serve`はこれを現在値の再読の
 * きっかけとして扱うだけで、Job開始条件そのものにはしない。
 */
export const notificationWakeEventSchema = v.strictObject({
  type: v.literal("notification.wake"),
  source: v.picklist(["github", "linear"]),
});

export const notificationServerMessageSchema = v.variant("type", [
  notificationWakeEventSchema,
]);

export type NotificationServerMessage = v.InferOutput<
  typeof notificationServerMessageSchema
>;

/**
 * `serve`が自分のLinear teamをrelayへ登録する。
 *
 * ADR 0001のとおり、relayは「routingに使うLinear workspace IDとteam ID」を
 * 永続化してよいが、Linear tokenは保持しない。この登録はLinear webhookを
 * どのrepositoryへ配送するかのroutingにだけ使う。
 */
export const linearRoutingRequestSchema = v.strictObject({
  linearTeamId: nonEmptyString,
});

export type LinearRoutingRequest = v.InferOutput<
  typeof linearRoutingRequestSchema
>;

export const linearRoutingResponseSchema = v.strictObject({
  linearTeamId: nonEmptyString,
  installationId: positiveInteger,
  repositoryId: positiveInteger,
});

export type LinearRoutingResponse = v.InferOutput<
  typeof linearRoutingResponseSchema
>;

export function parseNotificationServerMessage(
  value: unknown,
): NotificationServerMessage {
  return v.parse(notificationServerMessageSchema, value);
}

export function parseLinearRoutingRequest(
  value: unknown,
): LinearRoutingRequest {
  return v.parse(linearRoutingRequestSchema, value);
}

export function parseLinearRoutingResponse(
  value: unknown,
): LinearRoutingResponse {
  return v.parse(linearRoutingResponseSchema, value);
}
