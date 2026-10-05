import {
  parseDeviceCancellationRequest,
  parseDeviceTokenExchangeRequest,
  parseInstallationTokenRequest,
  parseLinearRoutingRequest,
  type DeviceRegistrationPurpose,
  type DeviceTokenExchangeResponse,
  type GitHubInstallation,
  type InstallationTokenResponse,
  type LinearRoutingResponse,
} from "@mikan-919/oriel-contracts";
import { Hono } from "hono";

import {
  randomSecret,
  sha256Base64Url,
  sha256Hex,
  signPayload,
  verifyHmacSha256Hex,
  verifyPayload,
} from "./crypto";
import type { DeviceRegistryObject } from "./device-registry-object";
import type { RelayGitHubClient } from "./github";
import {
  assertInstallationTokenPermissions,
  permissionsForPurpose,
} from "./installation-token-permissions";

export interface RelayOptions {
  github: RelayGitHubClient;
  deviceRegistry: DurableObjectNamespace<DeviceRegistryObject>;
  signingKey: string;
  relayOrigin: string;
  /** 運用値は測定と検証専用環境から決めるため、relayは既定値を持たない。 */
  codeExpiryMs: number;
  cancellationExpiryMs: number;
  /** 所有権接続の生存確認。server側失効期限はclient側停止期限より長くする。 */
  ownershipHeartbeatIntervalMs: number;
  ownershipHeartbeatExpiryMs: number;
  ownershipAuditIntervalMs: number;
  /** repository scopeのtranscript検索が、接続中の他の`serve`を待つ上限。 */
  transcriptSearchTimeoutMs: number;
  /**
   * installation tokenへ載せる最小権限。deploy設定から与えるが、固定allowlistを
   * 越える権限はrelayが受け付けない。
   */
  installationTokenPermissions: Record<string, string>;
  /** GitHub Appのwebhook secret。`X-Hub-Signature-256`の検証に使う。 */
  githubWebhookSecret: string;
  /** Linear webhookのsigning secret。`Linear-Signature`の検証に使う。 */
  linearWebhookSecret: string;
  /** Linearの`webhookTimestamp`が許容する現在時刻からのずれ。replay対策。 */
  linearWebhookMaxSkewMs: number;
  now?: () => number;
}

interface AuthorizationState {
  codeChallenge: string;
  state: string;
  purpose: DeviceRegistrationPurpose;
  deviceId: string | null;
  installationId: number;
  repositoryId: number;
  redirectUri: string;
  expiresAt: number;
}

const oauthCallbackPath = "/device/authorize/callback";
/** installation選択のcodeだけを預かる、repositoryに紐付かない登録簿。 */
const discoveryRegistryName = "discovery";

/** localhostへ戻す先はloopbackだけに限る。 */
function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** codeと取消証明とdevice tokenは、担当するDurable Objectへの経路情報を前置きする。 */
function routedSecret(installationId: number, repositoryId: number): string {
  return `${installationId}.${repositoryId}.${randomSecret()}`;
}

function routeOf(
  value: string,
): { installationId: number; repositoryId: number } | null {
  const [installationId, repositoryId] = value.split(".");
  const parsed = {
    installationId: Number(installationId),
    repositoryId: Number(repositoryId),
  };

  return Number.isInteger(parsed.installationId) &&
    parsed.installationId >= 0 &&
    Number.isInteger(parsed.repositoryId) &&
    parsed.repositoryId >= 0
    ? parsed
    : null;
}

function isPurpose(value: string): value is DeviceRegistrationPurpose {
  return (
    value === "installations" ||
    value === "registration" ||
    value === "device_list" ||
    value === "revocation"
  );
}

export function createRelayApp({
  github,
  deviceRegistry,
  signingKey,
  relayOrigin,
  codeExpiryMs,
  cancellationExpiryMs,
  ownershipHeartbeatIntervalMs,
  ownershipHeartbeatExpiryMs,
  ownershipAuditIntervalMs,
  transcriptSearchTimeoutMs,
  installationTokenPermissions,
  githubWebhookSecret,
  linearWebhookSecret,
  linearWebhookMaxSkewMs,
  now = Date.now,
}: RelayOptions) {
  // 広い権限のまま起動しない。設定の誤りはtoken発行より前にfail closedにする。
  const grantedPermissions = assertInstallationTokenPermissions(
    installationTokenPermissions,
  );
  const app = new Hono();

  function registryFor(installationId: number, repositoryId: number) {
    const name =
      installationId === 0
        ? discoveryRegistryName
        : `${installationId}/${repositoryId}`;

    return deviceRegistry.get(deviceRegistry.idFromName(name));
  }

  async function listInstallations(
    userToken: string,
  ): Promise<GitHubInstallation[]> {
    const installations = await github.listInstallations(userToken);

    return Promise.all(
      installations.map(async (installation) => ({
        installationId: installation.id,
        account: installation.account,
        canAdminister: await github.canAdministerInstallation({
          userToken,
          installationId: installation.id,
        }),
        repositories: (
          await github.listInstallationRepositories({
            userToken,
            installationId: installation.id,
          })
        ).map((repository) => ({
          repositoryId: repository.id,
          repository: { owner: repository.owner, name: repository.name },
        })),
      })),
    );
  }

  app.get("/device/authorize", async (context) => {
    const parameters = new URL(context.req.url).searchParams;
    const rawPurpose = parameters.get("purpose") ?? "registration";
    const purpose = isPurpose(rawPurpose) ? rawPurpose : null;
    const discovering = purpose === "installations";
    const installationId = discovering
      ? 0
      : Number(parameters.get("installation_id"));
    const repositoryId = discovering
      ? 0
      : Number(parameters.get("repository_id"));
    const deviceId = parameters.get("device_id");
    const codeChallenge = parameters.get("code_challenge") ?? "";
    const state = parameters.get("state") ?? "";
    const redirectUri = parameters.get("redirect_uri") ?? "";

    if (
      purpose === null ||
      !Number.isInteger(installationId) ||
      !Number.isInteger(repositoryId) ||
      (!discovering && (installationId <= 0 || repositoryId <= 0)) ||
      (purpose === "revocation" && (deviceId === null || deviceId === "")) ||
      codeChallenge === "" ||
      state === "" ||
      parameters.get("code_challenge_method") !== "S256" ||
      !isLoopbackRedirect(redirectUri)
    ) {
      return context.text("Bad Request", 400);
    }

    const authorizationState: AuthorizationState = {
      codeChallenge,
      state,
      purpose,
      deviceId,
      installationId,
      repositoryId,
      redirectUri,
      expiresAt: now() + codeExpiryMs,
    };

    return context.redirect(
      github.authorizeUrl({
        state: await signPayload(signingKey, authorizationState),
        redirectUri: `${relayOrigin}${oauthCallbackPath}`,
      }),
      302,
    );
  });

  app.get(oauthCallbackPath, async (context) => {
    const parameters = new URL(context.req.url).searchParams;
    const started = await verifyPayload<AuthorizationState>(
      signingKey,
      parameters.get("state") ?? "",
    );

    // 署名済みstateを信じ切らず、戻し先がloopbackであることを多層防御で再確認する。
    if (
      started === null ||
      started.expiresAt < now() ||
      !isLoopbackRedirect(started.redirectUri)
    ) {
      return context.text("Bad Request", 400);
    }

    // 操作のたびに新しいGitHub loginを求め、その場の現在値だけで判断する。
    const userToken = await github.exchangeAuthorizationCode({
      code: parameters.get("code") ?? "",
      redirectUri: `${relayOrigin}${oauthCallbackPath}`,
    });
    const viewer =
      userToken === null ? null : await github.getViewer(userToken);

    if (userToken === null || viewer === null) {
      return context.text("Unauthorized", 401);
    }

    let repositoryOwner = "";
    let repositoryName = "";

    if (started.purpose !== "installations") {
      const repositories = await github.listInstallationRepositories({
        userToken,
        installationId: started.installationId,
      });
      const repository = repositories.find(
        (candidate) => candidate.id === started.repositoryId,
      );

      if (repository === undefined) {
        return context.text("Forbidden", 403);
      }

      repositoryOwner = repository.owner;
      repositoryName = repository.name;

      // 失効と一覧はinstallationを現在管理できるGitHub userだけに許す。
      if (
        started.purpose !== "registration" &&
        !(await github.canAdministerInstallation({
          userToken,
          installationId: started.installationId,
        }))
      ) {
        return context.text("Forbidden", 403);
      }
    }

    const code = routedSecret(started.installationId, started.repositoryId);
    const registry = registryFor(started.installationId, started.repositoryId);

    await registry.purgeExpired(now());
    await registry.issueCode({
      codeHash: await sha256Hex(code),
      codeChallenge: started.codeChallenge,
      state: started.state,
      purpose: started.purpose,
      deviceId: started.deviceId ?? undefined,
      installationId: started.installationId,
      repositoryId: started.repositoryId,
      repositoryOwner,
      repositoryName,
      expiresAt: now() + codeExpiryMs,
    });

    if (started.purpose === "installations") {
      // 選択肢はcodeの交換時に返す。localhostへ戻るURLへはcodeとstateだけを載せる。
      await registry.rememberInstallations(
        await sha256Hex(code),
        JSON.stringify(await listInstallations(userToken)),
        now() + codeExpiryMs,
      );
    }

    const target = new URL(started.redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", started.state);

    return context.redirect(target.toString(), 302);
  });

  app.post("/device/token", async (context) => {
    let request;

    try {
      request = parseDeviceTokenExchangeRequest(await context.req.json());
    } catch {
      return context.text("Bad Request", 400);
    }

    const route = routeOf(request.code);

    if (route === null) {
      return context.text("Bad Request", 400);
    }

    const registry = registryFor(route.installationId, route.repositoryId);
    const codeHash = await sha256Hex(request.code);
    const consumed = await registry.consumeCode(codeHash);

    if (
      consumed === null ||
      consumed.expiresAt < now() ||
      (await sha256Base64Url(request.codeVerifier)) !== consumed.codeChallenge
    ) {
      return context.text("Bad Request", 400);
    }

    const repository = {
      owner: consumed.repositoryOwner,
      name: consumed.repositoryName,
    };
    const target = {
      installationId: consumed.installationId,
      repositoryId: consumed.repositoryId,
      repository,
    };

    if (consumed.purpose === "installations") {
      const remembered = await registry.takeInstallations(codeHash);

      return context.json({
        purpose: "installations",
        installations: JSON.parse(remembered ?? "[]") as GitHubInstallation[],
      } satisfies DeviceTokenExchangeResponse);
    }

    if (consumed.purpose === "device_list") {
      return context.json({
        purpose: "device_list",
        ...target,
        devices: await registry.listDevices(),
      } satisfies DeviceTokenExchangeResponse);
    }

    if (consumed.purpose === "revocation") {
      const revoked =
        consumed.deviceId === null
          ? null
          : await registry.revokeDevice(consumed.deviceId, now());

      if (revoked === null || revoked.revokedAt === null) {
        return context.text("Not Found", 404);
      }

      return context.json({
        purpose: "revocation",
        ...target,
        deviceId: revoked.deviceId,
        revokedAt: revoked.revokedAt,
      } satisfies DeviceTokenExchangeResponse);
    }

    const deviceToken = routedSecret(
      consumed.installationId,
      consumed.repositoryId,
    );
    const cancellationToken = routedSecret(
      consumed.installationId,
      consumed.repositoryId,
    );
    const cancellationExpiresAt = now() + cancellationExpiryMs;
    const registered = await registry.registerDevice({
      deviceId: crypto.randomUUID(),
      deviceTokenHash: await sha256Hex(deviceToken),
      cancellationTokenHash: await sha256Hex(cancellationToken),
      cancellationExpiresAt,
      installationId: consumed.installationId,
      repositoryId: consumed.repositoryId,
      repositoryOwner: repository.owner,
      repositoryName: repository.name,
      registeredAt: now(),
    });

    return context.json({
      purpose: "registration",
      deviceId: registered.deviceId,
      deviceToken,
      cancellationToken,
      cancellationExpiresAt,
      ...target,
    } satisfies DeviceTokenExchangeResponse);
  });

  app.post("/device/cancellation", async (context) => {
    let request;

    try {
      request = parseDeviceCancellationRequest(await context.req.json());
    } catch {
      return context.text("Bad Request", 400);
    }

    const route = routeOf(request.cancellationToken);

    if (route === null) {
      return context.text("Forbidden", 403);
    }

    const outcome = await registryFor(
      route.installationId,
      route.repositoryId,
    ).cancelIssuedDevice({
      deviceId: request.deviceId,
      cancellationTokenHash: await sha256Hex(request.cancellationToken),
      now: now(),
    });

    return outcome === "cancelled"
      ? context.json({ deviceId: request.deviceId, cancelled: true })
      : context.text("Forbidden", 403);
  });

  /** device bearer tokenを解決する。失効したdeviceは解決しない。 */
  async function authenticateDevice(authorization: string | undefined) {
    const deviceToken = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const route = routeOf(deviceToken);

    if (route === null || route.installationId === 0) {
      return null;
    }

    const device = await registryFor(
      route.installationId,
      route.repositoryId,
    ).authenticateDevice(await sha256Hex(deviceToken));

    return device;
  }

  /**
   * 登録済みdeviceへ、そのrepositoryと用途だけに絞った短命installation tokenを
   * 渡す。用途が必要としない権限は載せない。relayはtokenもGitHub user tokenも
   * 秘密鍵も保存しない。
   */
  app.post("/device/installation-token", async (context) => {
    const device = await authenticateDevice(
      context.req.header("authorization"),
    );

    if (device === null) {
      return context.text("Unauthorized", 401);
    }

    let request;

    try {
      request = parseInstallationTokenRequest(await context.req.json());
    } catch {
      return context.text("Bad Request", 400);
    }

    const permissions = permissionsForPurpose(
      grantedPermissions,
      request.purpose,
    );

    // 用途が要する権限をdeploy設定が与えていなければ、広い権限で代替しない。
    if (permissions === null) {
      return context.text("Forbidden", 403);
    }

    const issued = await github.createInstallationAccessToken({
      installationId: device.installationId,
      repositoryIds: [device.repositoryId],
      permissions,
    });

    if (issued === null) {
      return context.text("Bad Gateway", 502);
    }

    return context.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
      purpose: request.purpose,
      installationId: device.installationId,
      repositoryId: device.repositoryId,
    } satisfies InstallationTokenResponse);
  });

  /**
   * `serve`が自分のLinear teamをrelayへ登録する。ADR 0001のとおりrelayが
   * 永続化してよいのは「routingに使うLinear workspace IDとteam ID」だけで、
   * Linear tokenは保持しない。登録先は常にrepositoryに紐付かない共有
   * `discovery`インスタンスとする。
   */
  app.post("/device/linear-routing", async (context) => {
    const device = await authenticateDevice(
      context.req.header("authorization"),
    );

    if (device === null) {
      return context.text("Unauthorized", 401);
    }

    let request;

    try {
      request = parseLinearRoutingRequest(await context.req.json());
    } catch {
      return context.text("Bad Request", 400);
    }

    await registryFor(0, 0).registerLinearRoute({
      linearTeamId: request.linearTeamId,
      installationId: device.installationId,
      repositoryId: device.repositoryId,
      registeredAt: now(),
    });

    return context.json({
      linearTeamId: request.linearTeamId,
      installationId: device.installationId,
      repositoryId: device.repositoryId,
    } satisfies LinearRoutingResponse);
  });

  /**
   * webhookの起床通知だけを購読する接続。ADR 0001のとおりwebhookは起床通知に
   * 過ぎないため、この接続にlease、取得ID、heartbeatは持たせない。
   */
  app.get("/notifications", async (context) => {
    if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return context.text("Upgrade Required", 426);
    }

    const authorization = context.req.header("authorization") ?? "";
    const deviceToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const route = routeOf(deviceToken);

    if (route === null || route.installationId === 0) {
      return context.text("Unauthorized", 401);
    }

    return registryFor(route.installationId, route.repositoryId).fetch(
      new Request(context.req.url, {
        headers: {
          upgrade: "websocket",
          "x-device-token-hash": await sha256Hex(deviceToken),
          "x-notification-channel": "1",
          "x-transcript-search-timeout-ms": String(transcriptSearchTimeoutMs),
        },
      }),
    );
  });

  /**
   * GitHub Appのwebhook。固定URLで、`installation.id`/`repository.id`から
   * 動的にrouting先を決める。payload内容は保存・転送せず、routing先へ最小限の
   * 起床合図だけを送る。
   */
  app.post("/webhooks/github", async (context) => {
    const rawBody = await context.req.text();
    const signatureHeader = context.req.header("x-hub-signature-256") ?? "";
    const signatureHex = signatureHeader.startsWith("sha256=")
      ? signatureHeader.slice(7)
      : "";

    if (
      !(await verifyHmacSha256Hex(githubWebhookSecret, rawBody, signatureHex))
    ) {
      return context.text("Unauthorized", 401);
    }

    // Issue本体とcommentだけが起床対象。ADR 0006のとおりcontentは読まない。
    const githubEvent = context.req.header("x-github-event");

    if (githubEvent !== "issues" && githubEvent !== "issue_comment") {
      return context.text("", 202);
    }

    let payload: {
      installation?: { id?: unknown };
      repository?: { id?: unknown };
    };

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return context.text("", 202);
    }

    const installationId = payload.installation?.id;
    const repositoryId = payload.repository?.id;

    if (
      typeof installationId !== "number" ||
      typeof repositoryId !== "number" ||
      installationId <= 0 ||
      repositoryId <= 0
    ) {
      return context.text("", 202);
    }

    await registryFor(installationId, repositoryId).broadcastWake({
      source: "github",
    });

    return context.text("", 202);
  });

  /**
   * Linearのwebhook。固定URLで、事前に登録されたteam→repositoryのroutingを
   * 引く。`webhookTimestamp`が新しいことも確認し、replayを防ぐ
   * （Linear公式ドキュメントの推奨方式）。
   */
  app.post("/webhooks/linear", async (context) => {
    const rawBody = await context.req.text();
    const signatureHex = context.req.header("linear-signature") ?? "";

    if (
      !(await verifyHmacSha256Hex(linearWebhookSecret, rawBody, signatureHex))
    ) {
      return context.text("Unauthorized", 401);
    }

    let payload: {
      type?: unknown;
      webhookTimestamp?: unknown;
      data?: { teamId?: unknown };
    };

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return context.text("", 202);
    }

    if (
      typeof payload.webhookTimestamp !== "number" ||
      Math.abs(now() - payload.webhookTimestamp) > linearWebhookMaxSkewMs
    ) {
      return context.text("Unauthorized", 401);
    }

    // Issue以外のentity typeは、この製品のadmission対象を早める必要がない。
    if (payload.type !== "Issue") {
      return context.text("", 202);
    }

    const teamId = payload.data?.teamId;

    if (typeof teamId !== "string" || teamId === "") {
      return context.text("", 202);
    }

    const routes = await registryFor(0, 0).linearRoutesFor(teamId);

    await Promise.all(
      routes.map((route) =>
        registryFor(route.installationId, route.repositoryId).broadcastWake({
          source: "linear",
        }),
      ),
    );

    return context.text("", 202);
  });

  // 所有権接続。device bearer tokenはAuthorization headerだけで受け取る。
  app.get("/ownership", async (context) => {
    if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return context.text("Upgrade Required", 426);
    }

    const authorization = context.req.header("authorization") ?? "";
    const deviceToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const route = routeOf(deviceToken);
    const parameters = new URL(context.req.url).searchParams;
    const key = parameters.get("key") ?? "";

    if (route === null || route.installationId === 0 || key === "") {
      return context.text("Unauthorized", 401);
    }

    // upgradeはDurable Objectが受け、接続付随情報として所有権を持つ。
    return registryFor(route.installationId, route.repositoryId).fetch(
      new Request(context.req.url, {
        headers: {
          upgrade: "websocket",
          "x-device-token-hash": await sha256Hex(deviceToken),
          "x-ownership-heartbeat-interval-ms": String(
            ownershipHeartbeatIntervalMs,
          ),
          "x-ownership-heartbeat-expiry-ms": String(ownershipHeartbeatExpiryMs),
          "x-ownership-audit-interval-ms": String(ownershipAuditIntervalMs),
        },
      }),
    );
  });

  return app;
}
