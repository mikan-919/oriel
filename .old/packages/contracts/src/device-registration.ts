import * as v from "valibot";

import { githubRepositorySchema } from "./github";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * device登録と管理の各操作。どれも一回限りのGitHub loginを伴い、
 * relayはその都度の現在値だけで判断する。
 */
export const deviceRegistrationPurposeSchema = v.picklist([
  "installations",
  "registration",
  "device_list",
  "revocation",
]);

export type DeviceRegistrationPurpose = v.InferOutput<
  typeof deviceRegistrationPurposeSchema
>;

/** relayからlocalhostへ戻るURLへ載せてよいのは短命codeとstateだけとする。 */
export const deviceRegistrationCallbackSchema = v.strictObject({
  code: nonEmptyString,
  state: nonEmptyString,
});

export type DeviceRegistrationCallback = v.InferOutput<
  typeof deviceRegistrationCallbackSchema
>;

export const deviceTokenExchangeRequestSchema = v.strictObject({
  code: nonEmptyString,
  codeVerifier: nonEmptyString,
});

export type DeviceTokenExchangeRequest = v.InferOutput<
  typeof deviceTokenExchangeRequestSchema
>;

const registeredRepositorySchema = v.strictObject({
  installationId: positiveInteger,
  repositoryId: positiveInteger,
  repository: githubRepositorySchema,
});

/** relayが永続化してよい表示metadata。tokenのhashは外へ出さない。 */
export const deviceRecordSchema = v.strictObject({
  deviceId: nonEmptyString,
  ...registeredRepositorySchema.entries,
  registeredAt: positiveInteger,
  revokedAt: v.nullable(positiveInteger),
});

export type DeviceRecord = v.InferOutput<typeof deviceRecordSchema>;

export const installationRepositorySchema = v.strictObject({
  repositoryId: positiveInteger,
  repository: githubRepositorySchema,
});

export const githubInstallationSchema = v.strictObject({
  installationId: positiveInteger,
  account: nonEmptyString,
  /** 失効を実行できるのは、この値が真であるinstallationだけ。 */
  canAdminister: v.boolean(),
  repositories: v.array(installationRepositorySchema),
});

export type GitHubInstallation = v.InferOutput<typeof githubInstallationSchema>;

/** 対象を選ぶための現在のinstallationとrepository。 */
export const installationsExchangeResponseSchema = v.strictObject({
  purpose: v.literal("installations"),
  installations: v.array(githubInstallationSchema),
});

/**
 * 登録の交換結果。`cancellationToken`はこのdeviceだけを取り消せる内部限定の証明で、
 * 通常の失効経路ではない。
 */
export const deviceRegistrationExchangeResponseSchema = v.strictObject({
  purpose: v.literal("registration"),
  deviceId: nonEmptyString,
  deviceToken: nonEmptyString,
  cancellationToken: nonEmptyString,
  cancellationExpiresAt: positiveInteger,
  ...registeredRepositorySchema.entries,
});

export type DeviceRegistrationExchangeResponse = v.InferOutput<
  typeof deviceRegistrationExchangeResponseSchema
>;

export const deviceListExchangeResponseSchema = v.strictObject({
  purpose: v.literal("device_list"),
  ...registeredRepositorySchema.entries,
  devices: v.array(deviceRecordSchema),
});

/** 失効はGitHub loginの直後にrelayが実行し、結果だけを返す。 */
export const deviceRevocationExchangeResponseSchema = v.strictObject({
  purpose: v.literal("revocation"),
  ...registeredRepositorySchema.entries,
  deviceId: nonEmptyString,
  revokedAt: positiveInteger,
});

export const deviceTokenExchangeResponseSchema = v.variant("purpose", [
  installationsExchangeResponseSchema,
  deviceRegistrationExchangeResponseSchema,
  deviceListExchangeResponseSchema,
  deviceRevocationExchangeResponseSchema,
]);

export type DeviceTokenExchangeResponse = v.InferOutput<
  typeof deviceTokenExchangeResponseSchema
>;

export const deviceCancellationRequestSchema = v.strictObject({
  deviceId: nonEmptyString,
  cancellationToken: nonEmptyString,
});

export type DeviceCancellationRequest = v.InferOutput<
  typeof deviceCancellationRequestSchema
>;

/**
 * 短命installation tokenの用途。用途ごとに必要な権限だけを載せるため、
 * `serve`は要求のたびにどの外部操作のためのtokenかを明示する。
 */
export const installationTokenPurposeSchema = v.picklist([
  "issue_conversation",
  "admission",
  "implementation",
  "pull_request",
  "pr_response",
]);

export type InstallationTokenPurpose = v.InferOutput<
  typeof installationTokenPurposeSchema
>;

export const installationTokenRequestSchema = v.strictObject({
  purpose: installationTokenPurposeSchema,
});

export type InstallationTokenRequest = v.InferOutput<
  typeof installationTokenRequestSchema
>;

/**
 * repositoryとpermissionsを絞った短命installation token。`serve`は要求した
 * 時だけ受け取り、どこにも永続化しない。
 */
export const installationTokenResponseSchema = v.strictObject({
  token: nonEmptyString,
  expiresAt: nonEmptyString,
  purpose: installationTokenPurposeSchema,
  installationId: positiveInteger,
  repositoryId: positiveInteger,
});

export type InstallationTokenResponse = v.InferOutput<
  typeof installationTokenResponseSchema
>;

export function parseInstallationTokenRequest(
  value: unknown,
): InstallationTokenRequest {
  return v.parse(installationTokenRequestSchema, value);
}

export function parseInstallationTokenResponse(
  value: unknown,
): InstallationTokenResponse {
  return v.parse(installationTokenResponseSchema, value);
}

/**
 * 所有権接続のapplication-level heartbeat。Hibernationの自動応答で返すため、
 * JSONではなく固定文字列とする。
 */
export const ownershipHeartbeatRequest = "ownership.ping";
export const ownershipHeartbeatResponse = "ownership.pong";

/**
 * 所有権接続の受理と失効。取得IDはrelayだけが発行する。
 * server側の失効期限を伝え、`serve`が自分の停止期限を短く保てるようにする。
 */
export const ownershipAcquiredEventSchema = v.strictObject({
  type: v.literal("ownership.acquired"),
  leaseId: nonEmptyString,
  heartbeatIntervalMs: positiveInteger,
  heartbeatExpiryMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export const ownershipRejectedEventSchema = v.strictObject({
  type: v.literal("ownership.rejected"),
  reason: v.picklist([
    "already_owned",
    "device_revoked",
    "ownership_not_current",
    "invalid_request",
  ]),
});

/** 生存確認が期限内に成立しなかった接続の失効。 */
export const ownershipExpiredEventSchema = v.strictObject({
  type: v.literal("ownership.expired"),
});

export const ownershipRevokedEventSchema = v.strictObject({
  type: v.literal("ownership.revoked"),
});

export const ownershipConfirmRequestSchema = v.strictObject({
  type: v.literal("ownership.confirm"),
  requestId: nonEmptyString,
  leaseId: nonEmptyString,
});

export const ownershipConfirmedEventSchema = v.strictObject({
  type: v.literal("ownership.confirmed"),
  requestId: nonEmptyString,
  current: v.boolean(),
});

/**
 * 同じrepositoryで現在生きている所有権キーの問い合わせ。
 *
 * ADR 0003のWorkflow全体の置換隔離を、`serve`が自分の接続越しに確認するための
 * 現在値である。relayはWorkflowの意味を持たず、接続付随情報から再構成した
 * 現在のキーだけを答える。所有権履歴は持たない。
 */
export const ownershipInspectRequestSchema = v.strictObject({
  type: v.literal("ownership.inspect"),
  requestId: nonEmptyString,
  leaseId: nonEmptyString,
});

export const ownershipStateEventSchema = v.strictObject({
  type: v.literal("ownership.state"),
  requestId: nonEmptyString,
  current: v.boolean(),
  jobKeys: v.array(nonEmptyString),
  branchKeys: v.array(nonEmptyString),
});

export const ownershipServerMessageSchema = v.variant("type", [
  ownershipAcquiredEventSchema,
  ownershipRejectedEventSchema,
  ownershipRevokedEventSchema,
  ownershipExpiredEventSchema,
  ownershipConfirmedEventSchema,
  ownershipStateEventSchema,
]);

export type OwnershipServerMessage = v.InferOutput<
  typeof ownershipServerMessageSchema
>;

export const ownershipClientMessageSchema = v.variant("type", [
  ownershipConfirmRequestSchema,
  ownershipInspectRequestSchema,
]);

export type OwnershipClientMessage = v.InferOutput<
  typeof ownershipClientMessageSchema
>;

export function parseDeviceRegistrationCallback(
  value: unknown,
): DeviceRegistrationCallback {
  return v.parse(deviceRegistrationCallbackSchema, value);
}

export function parseDeviceTokenExchangeRequest(
  value: unknown,
): DeviceTokenExchangeRequest {
  return v.parse(deviceTokenExchangeRequestSchema, value);
}

export function parseDeviceTokenExchangeResponse(
  value: unknown,
): DeviceTokenExchangeResponse {
  return v.parse(deviceTokenExchangeResponseSchema, value);
}

export function parseDeviceCancellationRequest(
  value: unknown,
): DeviceCancellationRequest {
  return v.parse(deviceCancellationRequestSchema, value);
}

export function parseOwnershipServerMessage(
  value: unknown,
): OwnershipServerMessage {
  return v.parse(ownershipServerMessageSchema, value);
}

export function parseOwnershipClientMessage(
  value: unknown,
): OwnershipClientMessage {
  return v.parse(ownershipClientMessageSchema, value);
}
