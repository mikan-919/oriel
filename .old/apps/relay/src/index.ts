import { identity, userAgent } from "@mikan-919/oriel-identity";

import { DeviceRegistryObject } from "./device-registry-object";
import { createGitHubClient } from "./github";
import {
  minimalInstallationTokenPermissions,
  parseInstallationTokenPermissions,
} from "./installation-token-permissions";
import { createRelayApp } from "./relay";

export { DeviceRegistryObject };

export interface RelayEnv {
  DEVICE_REGISTRY: DurableObjectNamespace<DeviceRegistryObject>;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  RELAY_SIGNING_KEY: string;
  RELAY_ORIGIN: string;
  RELAY_VERSION: string;
  /** 運用値はdeploy設定から与える。欠けている場合はfail closedにする。 */
  DEVICE_CODE_EXPIRY_MS: string;
  DEVICE_CANCELLATION_EXPIRY_MS: string;
  OWNERSHIP_HEARTBEAT_INTERVAL_MS: string;
  OWNERSHIP_HEARTBEAT_EXPIRY_MS: string;
  OWNERSHIP_AUDIT_INTERVAL_MS: string;
  TRANSCRIPT_SEARCH_TIMEOUT_MS: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_JWT_LIFETIME_SECONDS: string;
  /**
   * installation tokenへ載せる権限のJSON。省略時は固定allowlistの最小権限を使い、
   * 与えた場合もallowlistを越える権限は受け付けない。
   */
  INSTALLATION_TOKEN_PERMISSIONS?: string;
  /** GitHub Appのwebhook secret。`X-Hub-Signature-256`の検証に使う。 */
  GITHUB_APP_WEBHOOK_SECRET: string;
  /** Linear webhookのsigning secret。`Linear-Signature`の検証に使う。 */
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_WEBHOOK_MAX_SKEW_MS: string;
}

function requiredPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${identity.environmentPrefix}${name} is not configured`);
  }

  return parsed;
}

function requiredSecret(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(`${identity.environmentPrefix}${name} is not configured`);
  }

  return value;
}

export default {
  fetch(request: Request, env: RelayEnv, context: ExecutionContext) {
    const app = createRelayApp({
      github: createGitHubClient({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: requiredSecret(
          env.GITHUB_CLIENT_SECRET,
          "GITHUB_CLIENT_SECRET",
        ),
        userAgent: userAgent(env.RELAY_VERSION),
        appId: env.GITHUB_APP_ID,
        privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
        appJwtLifetimeSeconds: requiredPositiveInteger(
          env.GITHUB_APP_JWT_LIFETIME_SECONDS,
          "GITHUB_APP_JWT_LIFETIME_SECONDS",
        ),
      }),
      deviceRegistry: env.DEVICE_REGISTRY,
      signingKey: requiredSecret(env.RELAY_SIGNING_KEY, "RELAY_SIGNING_KEY"),
      relayOrigin: env.RELAY_ORIGIN,
      codeExpiryMs: requiredPositiveInteger(
        env.DEVICE_CODE_EXPIRY_MS,
        "DEVICE_CODE_EXPIRY_MS",
      ),
      cancellationExpiryMs: requiredPositiveInteger(
        env.DEVICE_CANCELLATION_EXPIRY_MS,
        "DEVICE_CANCELLATION_EXPIRY_MS",
      ),
      ownershipHeartbeatIntervalMs: requiredPositiveInteger(
        env.OWNERSHIP_HEARTBEAT_INTERVAL_MS,
        "OWNERSHIP_HEARTBEAT_INTERVAL_MS",
      ),
      ownershipHeartbeatExpiryMs: requiredPositiveInteger(
        env.OWNERSHIP_HEARTBEAT_EXPIRY_MS,
        "OWNERSHIP_HEARTBEAT_EXPIRY_MS",
      ),
      ownershipAuditIntervalMs: requiredPositiveInteger(
        env.OWNERSHIP_AUDIT_INTERVAL_MS,
        "OWNERSHIP_AUDIT_INTERVAL_MS",
      ),
      transcriptSearchTimeoutMs: requiredPositiveInteger(
        env.TRANSCRIPT_SEARCH_TIMEOUT_MS,
        "TRANSCRIPT_SEARCH_TIMEOUT_MS",
      ),
      installationTokenPermissions:
        env.INSTALLATION_TOKEN_PERMISSIONS === undefined
          ? minimalInstallationTokenPermissions
          : parseInstallationTokenPermissions(
              env.INSTALLATION_TOKEN_PERMISSIONS,
            ),
      githubWebhookSecret: requiredSecret(
        env.GITHUB_APP_WEBHOOK_SECRET,
        "GITHUB_APP_WEBHOOK_SECRET",
      ),
      linearWebhookSecret: requiredSecret(
        env.LINEAR_WEBHOOK_SECRET,
        "LINEAR_WEBHOOK_SECRET",
      ),
      linearWebhookMaxSkewMs: requiredPositiveInteger(
        env.LINEAR_WEBHOOK_MAX_SKEW_MS,
        "LINEAR_WEBHOOK_MAX_SKEW_MS",
      ),
    });

    return app.fetch(request, env, context);
  },
} satisfies ExportedHandler<RelayEnv>;
