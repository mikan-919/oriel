import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ownershipHeartbeatRequest,
  ownershipHeartbeatResponse,
} from "@mikan-919/oriel-contracts";

import { sha256Base64Url, sha256Hex, signPayload } from "./crypto";
import type { DeviceRegistryObject } from "./device-registry-object";
import type { RelayGitHubClient } from "./github";
import { createRelayApp } from "./relay";

const installationId = 7;
// testごとに別のrepositoryを使い、Durable Objectを一つのtestだけで共有する。
let nextRepositoryId = 11;
let repository = { id: nextRepositoryId, owner: "mikan-919", name: "oriel" };
const adminCode = "github-oauth-code-admin";
const memberCode = "github-oauth-code-member";
const adminToken = "github-user-token-admin";
const memberToken = "github-user-token-member";
const codeVerifier = "code-verifier-value";
const redirectUri = "http://127.0.0.1:49152/device/callback";
const signingKey = "relay-signing-key";

let currentTime = 1_700_000_000_000;
let administrable = true;
// 生存確認の運用値はtestが与える。既定値は持たない。
let heartbeatExpiryMs = 60_000;
let transcriptSearchTimeoutMs = 60_000;
const githubWebhookSecret = "github-webhook-secret";
const linearWebhookSecret = "linear-webhook-secret";
const linearWebhookMaxSkewMs = 60_000;

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );

  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const github: RelayGitHubClient = {
  authorizeUrl: ({ state, redirectUri: callback }) =>
    `https://github.test/login/oauth/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(callback)}`,
  exchangeAuthorizationCode: async ({ code }) =>
    code === adminCode ? adminToken : code === memberCode ? memberToken : null,
  getViewer: async (userToken) =>
    userToken === adminToken
      ? { id: 1, login: "admin" }
      : userToken === memberToken
        ? { id: 2, login: "member" }
        : null,
  listInstallations: async () => [{ id: installationId, account: "mikan-919" }],
  listInstallationRepositories: async () => [repository],
  canAdministerInstallation: async ({ userToken }) =>
    administrable && userToken === adminToken,
  createInstallationAccessToken: async (input) => {
    issuedInstallationTokens.push(input);

    return installationTokenAvailable
      ? { token: "installation-token", expiresAt: "2026-08-14T00:10:00Z" }
      : null;
  },
};

let issuedInstallationTokens: {
  installationId: number;
  repositoryIds: number[];
  permissions: Record<string, string>;
}[] = [];
let installationTokenAvailable = true;

type Purpose = "installations" | "registration" | "device_list" | "revocation";

function relay(
  overrides: Partial<RelayGitHubClient> = {},
  installationTokenPermissions: Record<string, string> = {
    issues: "write",
    metadata: "read",
  },
) {
  return createRelayApp({
    github: { ...github, ...overrides },
    deviceRegistry: env.DEVICE_REGISTRY,
    signingKey,
    relayOrigin: "https://relay.test",
    codeExpiryMs: 60_000,
    cancellationExpiryMs: 120_000,
    ownershipHeartbeatIntervalMs: 1_000,
    ownershipHeartbeatExpiryMs: heartbeatExpiryMs,
    ownershipAuditIntervalMs: 5_000,
    transcriptSearchTimeoutMs,
    installationTokenPermissions,
    githubWebhookSecret,
    linearWebhookSecret,
    linearWebhookMaxSkewMs,
    now: () => currentTime,
  });
}

function registryStub() {
  return env.DEVICE_REGISTRY.get(
    env.DEVICE_REGISTRY.idFromName(`${installationId}/${repository.id}`),
  );
}

async function authorize(
  app: ReturnType<typeof relay>,
  purpose: Purpose,
  state: string,
  deviceId?: string,
) {
  const url = new URL("https://relay.test/device/authorize");
  url.searchParams.set("installation_id", String(installationId));
  url.searchParams.set("repository_id", String(repository.id));
  url.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("purpose", purpose);

  if (deviceId !== undefined) {
    url.searchParams.set("device_id", deviceId);
  }

  return app.fetch(new Request(url));
}

/** GitHub loginを終えてlocalhostへ戻るまでを一度に進める。 */
async function callbackToLocalhost(
  app: ReturnType<typeof relay>,
  purpose: Purpose = "registration",
  oauthCode = adminCode,
  state = "serve-state",
  deviceId?: string,
) {
  const redirect = await authorize(app, purpose, state, deviceId);
  const relayState = new URL(
    redirect.headers.get("location") ?? "",
  ).searchParams.get("state");
  const callbackUrl = new URL("https://relay.test/device/authorize/callback");
  callbackUrl.searchParams.set("code", oauthCode);
  callbackUrl.searchParams.set("state", relayState ?? "");

  return app.fetch(new Request(callbackUrl));
}

function exchangeCode(app: ReturnType<typeof relay>, code: string) {
  return app.fetch(
    new Request("https://relay.test/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    }),
  );
}

async function runOperation(
  app: ReturnType<typeof relay>,
  purpose: Purpose = "registration",
  oauthCode = adminCode,
  state = "serve-state",
  deviceId?: string,
) {
  const callback = await callbackToLocalhost(
    app,
    purpose,
    oauthCode,
    state,
    deviceId,
  );
  const location = new URL(callback.headers.get("location") ?? "");
  const code = location.searchParams.get("code") ?? "";

  return { callback, location, code, response: await exchangeCode(app, code) };
}

async function registerDevice(app: ReturnType<typeof relay>, state: string) {
  const { response } = await runOperation(
    app,
    "registration",
    adminCode,
    state,
  );

  return (await response.json()) as {
    deviceId: string;
    deviceToken: string;
    cancellationToken: string;
  };
}

function openOwnership(
  app: ReturnType<typeof relay>,
  input: {
    deviceToken: string;
    /** 未知のkindを拒むことも確かめるため、型ではなくrelay側で弾く。 */
    kind?: string;
    key: string;
    parentLeaseId?: string;
  },
) {
  const url = new URL("https://relay.test/ownership");

  if (input.kind !== undefined) {
    url.searchParams.set("kind", input.kind);
  }

  url.searchParams.set("key", input.key);

  if (input.parentLeaseId !== undefined) {
    url.searchParams.set("parent_lease_id", input.parentLeaseId);
  }

  return app.fetch(
    new Request(url, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${input.deviceToken}`,
      },
    }),
  );
}

/** 接続直後にrelayが送る受理か拒否、またはheartbeatの応答を読む。 */
function nextMessage(
  socket: WebSocket,
): Promise<Record<string, unknown> | string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const data = String(event.data);

      resolve(
        data.startsWith("{")
          ? (JSON.parse(data) as Record<string, unknown>)
          : data,
      );
    });
    socket.addEventListener("close", () => {
      reject(new Error("closed before a message arrived"));
    });
  });
}

function leaseIdOf(message: Record<string, unknown> | string): string {
  return typeof message === "string" ? "" : String(message.leaseId);
}

beforeEach(() => {
  currentTime = 1_700_000_000_000;
  administrable = true;
  heartbeatExpiryMs = 60_000;
  transcriptSearchTimeoutMs = 60_000;
  nextRepositoryId += 1;
  repository = { id: nextRepositoryId, owner: "mikan-919", name: "oriel" };
  issuedInstallationTokens = [];
  installationTokenAvailable = true;
});

describe("device registration through the relay", () => {
  it("returns only a one-time code and the state to localhost", async () => {
    const callback = await callbackToLocalhost(relay());
    const location = new URL(callback.headers.get("location") ?? "");

    expect(callback.status).toBe(302);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect([...location.searchParams.keys()].sort()).toEqual(["code", "state"]);
  });

  it("refuses a non-loopback redirect target and a plain code challenge", async () => {
    const app = relay();
    const url = new URL("https://relay.test/device/authorize");
    url.searchParams.set("installation_id", String(installationId));
    url.searchParams.set("repository_id", String(repository.id));
    url.searchParams.set("code_challenge", "challenge");
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "serve-state");
    url.searchParams.set("redirect_uri", "https://evil.test/device/callback");

    expect((await app.fetch(new Request(url))).status).toBe(400);

    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge_method", "plain");

    expect((await app.fetch(new Request(url))).status).toBe(400);
  });

  it("refuses a callback whose signed state carries a non-loopback redirect target", async () => {
    const app = relay();
    // 署名は正しいがredirectUriがloopbackでないstate。多層防御の層だけを突く。
    const forged = await signPayload(signingKey, {
      codeChallenge: await sha256Base64Url(codeVerifier),
      state: "serve-state",
      purpose: "registration",
      deviceId: null,
      installationId,
      repositoryId: repository.id,
      redirectUri: "https://evil.test/device/callback",
      expiresAt: Date.now() + 60_000,
    });
    const callbackUrl = new URL("https://relay.test/device/authorize/callback");

    callbackUrl.searchParams.set("code", adminCode);
    callbackUrl.searchParams.set("state", forged);

    const response = await app.fetch(new Request(callbackUrl));

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("exchanges the one-time code for a device token bound to the repository", async () => {
    const { response } = await runOperation(relay());
    const body = (await response.json()) as {
      deviceId: string;
      deviceToken: string;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      purpose: "registration",
      installationId,
      repositoryId: repository.id,
    });

    const authenticated = await runInDurableObject(
      registryStub(),
      async (instance: DeviceRegistryObject) =>
        instance.authenticateDevice(await sha256Hex(body.deviceToken)),
    );

    expect(authenticated).toMatchObject({ deviceId: body.deviceId });
  });

  it("consumes the one-time code exactly once even under concurrent exchanges", async () => {
    const app = relay();
    const callback = await callbackToLocalhost(app);
    const code =
      new URL(callback.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";
    const statuses = (
      await Promise.all([exchangeCode(app, code), exchangeCode(app, code)])
    ).map((response) => response.status);

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(1);
  });

  it("refuses an expired code", async () => {
    const app = relay();
    const callback = await callbackToLocalhost(app);
    const code =
      new URL(callback.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";

    currentTime += 60_001;

    expect((await exchangeCode(app, code)).status).toBe(400);
  });

  it("keeps the device registry across a Durable Object restart", async () => {
    const registered = await registerDevice(relay(), "serve-state");
    const deviceTokenHash = await sha256Hex(registered.deviceToken);

    // Durable Objectを落として、SQLiteから読み直させる。
    await runInDurableObject(
      registryStub(),
      (_instance: DeviceRegistryObject, state: DurableObjectState) => {
        state.abort("restart for the test");
      },
    ).catch(() => undefined);

    const afterRestart = await runInDurableObject(
      registryStub(),
      (instance: DeviceRegistryObject) =>
        instance.authenticateDevice(deviceTokenHash),
    );

    expect(afterRestart).toMatchObject({ deviceId: registered.deviceId });
  });

  it("lists the installations and repositories the signed-in user can choose", async () => {
    const app = relay();
    const { response } = await runOperation(
      app,
      "installations",
      adminCode,
      "discovery-state",
    );

    expect(await response.json()).toEqual({
      purpose: "installations",
      installations: [
        {
          installationId,
          account: "mikan-919",
          canAdminister: true,
          repositories: [
            {
              repositoryId: repository.id,
              repository: { owner: repository.owner, name: repository.name },
            },
          ],
        },
      ],
    });
  });
});

describe("device revocation through the relay", () => {
  it("checks the current installation administrator on every revocation", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    // 登録できたuserでも、失効時点で管理権限がなければ拒否する。
    const byMember = await callbackToLocalhost(
      app,
      "revocation",
      memberCode,
      "revoke-state",
      registered.deviceId,
    );

    expect(byMember.status).toBe(403);

    administrable = false;

    const afterLosingAdmin = await callbackToLocalhost(
      app,
      "revocation",
      adminCode,
      "revoke-state-2",
      registered.deviceId,
    );

    expect(afterLosingAdmin.status).toBe(403);
    expect(
      await runInDurableObject(registryStub(), async (instance) =>
        instance.authenticateDevice(await sha256Hex(registered.deviceToken)),
      ),
    ).not.toBeNull();

    administrable = true;

    const { response } = await runOperation(
      app,
      "revocation",
      adminCode,
      "revoke-state-3",
      registered.deviceId,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      purpose: "revocation",
      deviceId: registered.deviceId,
    });
    expect(
      await runInDurableObject(registryStub(), async (instance) =>
        instance.authenticateDevice(await sha256Hex(registered.deviceToken)),
      ),
    ).toBeNull();
  });

  it("lists devices only for a current installation administrator", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    expect(
      (await callbackToLocalhost(app, "device_list", memberCode, "list-state"))
        .status,
    ).toBe(403);

    const { response } = await runOperation(
      app,
      "device_list",
      adminCode,
      "list-state-2",
    );

    expect(await response.json()).toMatchObject({
      purpose: "device_list",
      devices: [{ deviceId: registered.deviceId, revokedAt: null }],
    });
  });

  it("cancels only the device its proof was issued for", async () => {
    const app = relay();
    const first = await registerDevice(app, "first-state");
    const second = await registerDevice(app, "second-state");
    const cancel = (body: { deviceId: string; cancellationToken: string }) =>
      app.fetch(
        new Request("https://relay.test/device/cancellation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    expect(
      (
        await cancel({
          deviceId: second.deviceId,
          cancellationToken: first.cancellationToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await cancel({
          deviceId: first.deviceId,
          cancellationToken: first.cancellationToken,
        })
      ).status,
    ).toBe(200);
    expect(
      await runInDurableObject(registryStub(), async (instance) =>
        instance.authenticateDevice(await sha256Hex(first.deviceToken)),
      ),
    ).toBeNull();
  });
});

describe("ownership connections on the relay", () => {
  it("grants Job ownership and branch exclusivity to one connection at a time", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const job = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });
    const jobSocket = job.webSocket!;

    jobSocket.accept();

    const acquired = await nextMessage(jobSocket);

    expect(job.status).toBe(101);
    expect(acquired).toMatchObject({
      type: "ownership.acquired",
      heartbeatIntervalMs: 1_000,
      heartbeatExpiryMs: 60_000,
    });

    const second = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });

    second.webSocket!.accept();

    expect(await nextMessage(second.webSocket!)).toEqual({
      type: "ownership.rejected",
      reason: "already_owned",
    });

    const branch = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "branch",
      key: `${repository.id}/oriel-job-1`,
      parentLeaseId: leaseIdOf(acquired),
    });

    branch.webSocket!.accept();

    expect(await nextMessage(branch.webSocket!)).toMatchObject({
      type: "ownership.acquired",
    });

    const orphanBranch = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "branch",
      key: `${repository.id}/other`,
      parentLeaseId: "not-current",
    });

    orphanBranch.webSocket!.accept();

    expect(await nextMessage(orphanBranch.webSocket!)).toEqual({
      type: "ownership.rejected",
      reason: "ownership_not_current",
    });
  });

  it("refuses ownership without a valid device bearer token", async () => {
    const app = relay();

    expect(
      (
        await openOwnership(relay(), {
          deviceToken: `${installationId}.${repository.id}.forged`,
          kind: "job",
          key: "job-1",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request("https://relay.test/ownership?kind=job&key=job-1"),
        )
      ).status,
    ).toBe(426);
  });

  it("answers the live ownership keys of the repository to a current owner", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const job = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "implementation:11:28:aaa",
    });
    const jobSocket = job.webSocket!;

    jobSocket.accept();

    const jobLeaseId = leaseIdOf(await nextMessage(jobSocket));
    const branch = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "branch",
      key: `${repository.id}/oriel/ENG-12-gh-28-aaa`,
      parentLeaseId: jobLeaseId,
    });

    branch.webSocket!.accept();
    await nextMessage(branch.webSocket!);

    const state = nextMessage(jobSocket);

    jobSocket.send(
      JSON.stringify({
        type: "ownership.inspect",
        requestId: "inspect-1",
        leaseId: jobLeaseId,
      }),
    );

    // 置換隔離の判断はserveが行う。relayは現在の接続キーだけを答える。
    expect(await state).toEqual({
      type: "ownership.state",
      requestId: "inspect-1",
      current: true,
      jobKeys: ["implementation:11:28:aaa"],
      branchKeys: [`${repository.id}/oriel/ENG-12-gh-28-aaa`],
    });

    const stale = nextMessage(jobSocket);

    jobSocket.send(
      JSON.stringify({
        type: "ownership.inspect",
        requestId: "inspect-2",
        leaseId: "not-current",
      }),
    );

    // 現在の取得IDでない問い合わせには現在値を渡さない。
    expect(await stale).toEqual({
      type: "ownership.state",
      requestId: "inspect-2",
      current: false,
      jobKeys: [],
      branchKeys: [],
    });
  });

  it("counts no expired connection as live ownership, and answers no stale owner", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const fresh = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "implementation:11:28:current",
    });
    const freshSocket = fresh.webSocket!;

    freshSocket.accept();

    const freshLeaseId = leaseIdOf(await nextMessage(freshSocket));

    // 同じrepositoryで、heartbeatの期限が尽きた旧Jobの接続。
    heartbeatExpiryMs = 0;

    const staleApp = relay();
    const stale = await openOwnership(staleApp, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "implementation:11:28:older",
    });
    const staleSocket = stale.webSocket!;

    staleSocket.accept();

    await nextMessage(staleSocket);

    const staleClosed = new Promise<number>((resolve) => {
      staleSocket.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });
    const state = nextMessage(freshSocket);

    freshSocket.send(
      JSON.stringify({
        type: "ownership.inspect",
        requestId: "inspect-1",
        leaseId: freshLeaseId,
      }),
    );

    // 旧Jobは失効しているため、置換隔離を妨げる生きた所有権として数えない。
    expect(await state).toEqual({
      type: "ownership.state",
      requestId: "inspect-1",
      current: true,
      jobKeys: ["implementation:11:28:current"],
      branchKeys: [],
    });

    // 数える前に失効させるため、旧接続は問い合わせの処理中に閉じられている。
    expect(await staleClosed).toBe(4004);
  });

  it("answers a stale owner with the expiry, never with the live ownership", async () => {
    heartbeatExpiryMs = 0;

    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const stale = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "implementation:11:28:older",
    });
    const staleSocket = stale.webSocket!;

    staleSocket.accept();

    const leaseId = leaseIdOf(await nextMessage(staleSocket));
    const answer = new Promise<{ code: number; messages: unknown[] }>(
      (resolve) => {
        const messages: unknown[] = [];

        staleSocket.addEventListener("message", (event) => {
          messages.push(JSON.parse(String(event.data)));
        });
        staleSocket.addEventListener("close", (event) => {
          resolve({ code: event.code, messages });
        });
      },
    );

    staleSocket.send(
      JSON.stringify({
        type: "ownership.inspect",
        requestId: "inspect-1",
        leaseId,
      }),
    );

    // 自身の取得IDがまだ一致していても、失効した接続へ現在値を渡さない。
    expect(await answer).toEqual({
      code: 4004,
      messages: [{ type: "ownership.expired" }],
    });
  });

  it("invalidates and closes the ownership connections of a revoked device", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const job = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });
    const jobSocket = job.webSocket!;

    jobSocket.accept();

    const acquired = await nextMessage(jobSocket);
    const branch = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "branch",
      key: `${repository.id}/oriel-job-1`,
      parentLeaseId: leaseIdOf(acquired),
    });

    branch.webSocket!.accept();
    await nextMessage(branch.webSocket!);

    const closedJob = new Promise<number>((resolve) => {
      jobSocket.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });
    const closedBranch = new Promise<number>((resolve) => {
      branch.webSocket!.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });

    const { response } = await runOperation(
      app,
      "revocation",
      adminCode,
      "revoke-state",
      registered.deviceId,
    );

    expect(response.status).toBe(200);
    expect(await closedJob).toBe(4003);
    expect(await closedBranch).toBe(4003);

    // 失効後は同じdeviceで新しい接続を取れない。
    expect(
      (
        await openOwnership(app, {
          deviceToken: registered.deviceToken,
          kind: "job",
          key: "job-2",
        })
      ).status,
    ).toBe(401);
  });

  it("refuses an ownership connection whose kind is unknown or missing", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    for (const kind of [undefined, "", "Branch", "worktree"]) {
      expect(
        (
          await openOwnership(app, {
            deviceToken: registered.deviceToken,
            kind,
            key: "job-1",
          })
        ).status,
      ).toBe(401);
    }

    // 既知のkindはこれまでどおり受理する。
    expect(
      (
        await openOwnership(app, {
          deviceToken: registered.deviceToken,
          kind: "job",
          key: "job-1",
        })
      ).status,
    ).toBe(101);
  });

  it("closes the notification subscription of a revoked device without treating it as ownership", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const job = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });
    const jobSocket = job.webSocket!;
    const subscription = await openNotifications(app, registered.deviceToken);
    const notificationSocket = subscription.webSocket!;

    jobSocket.accept();
    await nextMessage(jobSocket);
    notificationSocket.accept();

    const received: unknown[] = [];

    notificationSocket.addEventListener("message", (event) => {
      received.push(JSON.parse(String(event.data)));
    });

    const closedNotification = new Promise<number>((resolve) => {
      notificationSocket.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });

    expect(
      (
        await runOperation(
          app,
          "revocation",
          adminCode,
          "revoke-state",
          registered.deviceId,
        )
      ).response.status,
    ).toBe(200);

    // 通知接続は所有権接続として扱われず、closeNotificationOfが閉じる。
    expect(await closedNotification).toBe(4003);
    expect(received).toEqual([]);
  });
});

describe("ownership liveness on the relay", () => {
  it("answers the application heartbeat without leaving hibernation", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const job = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });
    const socket = job.webSocket!;

    socket.accept();
    await nextMessage(socket);

    const pong = nextMessage(socket);

    socket.send(ownershipHeartbeatRequest);

    // 自動応答なのでwebSocketMessageは呼ばれない。
    expect(await pong).toBe(ownershipHeartbeatResponse);

    const audited = await runInDurableObject(
      registryStub(),
      (_instance: DeviceRegistryObject, state: DurableObjectState) =>
        state
          .getWebSockets()
          .map((ws) => state.getWebSocketAutoResponseTimestamp(ws) !== null),
    );

    expect(audited).toContain(true);
  });

  it("invalidates and closes a connection whose heartbeat expired, on the alarm and on a new acquisition", async () => {
    heartbeatExpiryMs = 0;

    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const stale = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });
    const staleSocket = stale.webSocket!;

    staleSocket.accept();
    await nextMessage(staleSocket);

    const expired = new Promise<{ code: number; message: unknown }>(
      (resolve) => {
        let message: unknown;

        staleSocket.addEventListener("message", (event) => {
          message = JSON.parse(String(event.data));
        });
        staleSocket.addEventListener("close", (event) => {
          resolve({ code: event.code, message });
        });
      },
    );

    // Alarmで最終heartbeatを監査し、期限を過ぎた接続を失効させてから閉じる。
    expect(await runDurableObjectAlarm(registryStub())).toBe(true);
    expect(await expired).toEqual({
      code: 4004,
      message: { type: "ownership.expired" },
    });

    // 失効済み接続は所有権として数えないため、同じキーを取り直せる。
    const replacement = await openOwnership(app, {
      deviceToken: registered.deviceToken,
      kind: "job",
      key: "job-1",
    });

    replacement.webSocket!.accept();

    expect(await nextMessage(replacement.webSocket!)).toMatchObject({
      type: "ownership.acquired",
    });
  });
});

describe("short lived installation tokens", () => {
  function requestInstallationToken(
    app: ReturnType<typeof relay>,
    deviceToken: string,
    purpose = "issue_conversation",
  ) {
    return app.fetch(
      new Request("https://relay.test/device/installation-token", {
        method: "POST",
        headers: {
          authorization: `Bearer ${deviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ purpose }),
      }),
    );
  }

  it("issues a token scoped to the repository of a valid device token", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const response = await requestInstallationToken(
      app,
      registered.deviceToken,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: "installation-token",
      expiresAt: "2026-08-14T00:10:00Z",
      purpose: "issue_conversation",
      installationId,
      repositoryId: repository.id,
    });
    expect(issuedInstallationTokens).toEqual([
      {
        installationId,
        repositoryIds: [repository.id],
        permissions: { issues: "write", metadata: "read" },
      },
    ]);
  });

  it("issues only the permissions the requested purpose needs", async () => {
    const app = relay(
      {},
      {
        contents: "write",
        issues: "write",
        pull_requests: "write",
        metadata: "read",
      },
    );
    const registered = await registerDevice(app, "serve-state");

    expect(
      (await requestInstallationToken(app, registered.deviceToken, "admission"))
        .status,
    ).toBe(200);
    expect(
      (
        await requestInstallationToken(
          app,
          registered.deviceToken,
          "implementation",
        )
      ).status,
    ).toBe(200);
    // admissionは読み取りだけ、実装はcanonicalブランチの送信だけを持つ。
    expect(
      issuedInstallationTokens.map((issued) => issued.permissions),
    ).toEqual([
      {
        contents: "read",
        issues: "read",
        pull_requests: "read",
        metadata: "read",
      },
      { contents: "write", metadata: "read" },
    ]);
  });

  it("refuses a request without a known purpose", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    expect(
      (await requestInstallationToken(app, registered.deviceToken, "admin"))
        .status,
    ).toBe(400);
    // 設定が与えていない権限を要する用途はfail closedにする。
    expect(
      (
        await requestInstallationToken(
          app,
          registered.deviceToken,
          "implementation",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          new Request("https://relay.test/device/installation-token", {
            method: "POST",
            headers: { authorization: `Bearer ${registered.deviceToken}` },
          }),
        )
      ).status,
    ).toBe(400);
    expect(issuedInstallationTokens).toEqual([]);
  });

  it("refuses to run with permissions wider than the product needs", () => {
    // 環境の設定JSONをそのまま通さず、固定allowlistと値検証で組み立てる。
    expect(() =>
      createRelayApp({
        github,
        deviceRegistry: env.DEVICE_REGISTRY,
        signingKey,
        relayOrigin: "https://relay.test",
        codeExpiryMs: 60_000,
        cancellationExpiryMs: 120_000,
        ownershipHeartbeatIntervalMs: 1_000,
        ownershipHeartbeatExpiryMs: heartbeatExpiryMs,
        ownershipAuditIntervalMs: 5_000,
        transcriptSearchTimeoutMs,
        installationTokenPermissions: {
          issues: "write",
          administration: "write",
        },
        githubWebhookSecret,
        linearWebhookSecret,
        linearWebhookMaxSkewMs,
        now: () => currentTime,
      }),
    ).toThrow();
    expect(issuedInstallationTokens).toEqual([]);
  });

  it("refuses a forged or revoked device token", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    expect(
      (
        await requestInstallationToken(
          app,
          `${installationId}.${repository.id}.forged`,
        )
      ).status,
    ).toBe(401);
    expect(issuedInstallationTokens).toEqual([]);

    await runOperation(
      app,
      "revocation",
      adminCode,
      "revoke-state",
      registered.deviceId,
    );

    expect(
      (await requestInstallationToken(app, registered.deviceToken)).status,
    ).toBe(401);
    expect(issuedInstallationTokens).toEqual([]);
  });

  it("does not persist the issued token", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    await requestInstallationToken(app, registered.deviceToken);

    const stored = await runInDurableObject(
      registryStub(),
      (_instance: DeviceRegistryObject, state: DurableObjectState) => ({
        keys: [
          ...state.storage.sql
            .exec<{ name: string }>(
              `SELECT name FROM sqlite_master WHERE type = 'table'`,
            )
            .toArray(),
        ].map((row) => row.name),
        rows: [
          ...state.storage.sql
            .exec<{ total: number }>(
              `SELECT count(*) AS total FROM devices WHERE device_token_hash LIKE '%installation-token%'`,
            )
            .toArray(),
        ],
      }),
    );

    expect(stored.keys).not.toContain("installation_tokens");
    expect(stored.rows[0]?.total).toBe(0);
  });

  it("fails closed when GitHub does not issue a token", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    installationTokenAvailable = false;

    expect(
      (await requestInstallationToken(app, registered.deviceToken)).status,
    ).toBe(502);
  });
});

function discoveryStub() {
  return env.DEVICE_REGISTRY.get(env.DEVICE_REGISTRY.idFromName("discovery"));
}

function openNotifications(app: ReturnType<typeof relay>, deviceToken: string) {
  return app.fetch(
    new Request("https://relay.test/notifications", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${deviceToken}`,
      },
    }),
  );
}

async function sendGithubWebhook(
  app: ReturnType<typeof relay>,
  event: string,
  payload: unknown,
) {
  const body = JSON.stringify(payload);

  return app.fetch(
    new Request("https://relay.test/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${await hmacHex(githubWebhookSecret, body)}`,
        "content-type": "application/json",
      },
      body,
    }),
  );
}

async function sendLinearWebhook(
  app: ReturnType<typeof relay>,
  payload: unknown,
) {
  const body = JSON.stringify(payload);

  return app.fetch(
    new Request("https://relay.test/webhooks/linear", {
      method: "POST",
      headers: {
        "linear-signature": await hmacHex(linearWebhookSecret, body),
        "content-type": "application/json",
      },
      body,
    }),
  );
}

describe("webhook wake notifications", () => {
  it("wakes a subscribed connection on a signed GitHub issues webhook", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const subscription = await openNotifications(app, registered.deviceToken);
    const socket = subscription.webSocket!;

    socket.accept();

    const wake = nextMessage(socket);
    const response = await sendGithubWebhook(app, "issues", {
      action: "opened",
      installation: { id: installationId },
      repository: { id: repository.id },
    });

    expect(response.status).toBe(202);
    expect(await wake).toEqual({ type: "notification.wake", source: "github" });
  });

  it("wakes a subscribed connection on a signed GitHub issue_comment webhook", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const subscription = await openNotifications(app, registered.deviceToken);
    const socket = subscription.webSocket!;

    socket.accept();

    const wake = nextMessage(socket);
    const response = await sendGithubWebhook(app, "issue_comment", {
      action: "created",
      installation: { id: installationId },
      repository: { id: repository.id },
    });

    expect(response.status).toBe(202);
    expect(await wake).toEqual({ type: "notification.wake", source: "github" });
  });

  it("refuses a GitHub webhook with an invalid signature", async () => {
    const app = relay();
    const body = JSON.stringify({
      installation: { id: installationId },
      repository: { id: repository.id },
    });
    const response = await app.fetch(
      new Request("https://relay.test/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-hub-signature-256": "sha256=deadbeef",
          "content-type": "application/json",
        },
        body,
      }),
    );

    expect(response.status).toBe(401);
  });

  it("ignores GitHub events other than issues and unregistered repositories", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const subscription = await openNotifications(app, registered.deviceToken);
    const socket = subscription.webSocket!;

    socket.accept();

    expect(
      (
        await sendGithubWebhook(app, "push", {
          installation: { id: installationId },
          repository: { id: repository.id },
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await sendGithubWebhook(app, "issues", {
          installation: { id: installationId },
          repository: { id: 999_999 },
        })
      ).status,
    ).toBe(202);

    // 無視されるwebhookはwakeを送らないため、次に届く一件目は
    // このあと送る有効なwebhookのwakeのはずである。
    const wake = nextMessage(socket);

    await sendGithubWebhook(app, "issues", {
      installation: { id: installationId },
      repository: { id: repository.id },
    });

    expect(await wake).toEqual({ type: "notification.wake", source: "github" });
  });

  it("wakes routes registered for a Linear team on a signed, fresh Issue webhook", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    await app.fetch(
      new Request("https://relay.test/device/linear-routing", {
        method: "POST",
        headers: {
          authorization: `Bearer ${registered.deviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ linearTeamId: "TEAM-1" }),
      }),
    );

    const subscription = await openNotifications(app, registered.deviceToken);
    const socket = subscription.webSocket!;

    socket.accept();

    const wake = nextMessage(socket);
    const response = await sendLinearWebhook(app, {
      type: "Issue",
      webhookTimestamp: currentTime,
      data: { teamId: "TEAM-1" },
    });

    expect(response.status).toBe(202);
    expect(await wake).toEqual({ type: "notification.wake", source: "linear" });
  });

  it("refuses a Linear webhook with an invalid signature or a stale timestamp", async () => {
    const app = relay();

    expect(
      (
        await app.fetch(
          new Request("https://relay.test/webhooks/linear", {
            method: "POST",
            headers: {
              "linear-signature": "deadbeef",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              type: "Issue",
              webhookTimestamp: currentTime,
              data: { teamId: "TEAM-1" },
            }),
          }),
        )
      ).status,
    ).toBe(401);

    expect(
      (
        await sendLinearWebhook(app, {
          type: "Issue",
          webhookTimestamp: currentTime - linearWebhookMaxSkewMs - 1,
          data: { teamId: "TEAM-1" },
        })
      ).status,
    ).toBe(401);
  });

  it("ignores an unregistered team and non-Issue payload types", async () => {
    const app = relay();

    expect(
      (
        await sendLinearWebhook(app, {
          type: "Issue",
          webhookTimestamp: currentTime,
          data: { teamId: "UNKNOWN-TEAM" },
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await sendLinearWebhook(app, {
          type: "Comment",
          webhookTimestamp: currentTime,
          data: { teamId: "TEAM-1" },
        })
      ).status,
    ).toBe(202);
  });

  it("registers and re-registers a Linear team route idempotently", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const register = () =>
      app.fetch(
        new Request("https://relay.test/device/linear-routing", {
          method: "POST",
          headers: {
            authorization: `Bearer ${registered.deviceToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ linearTeamId: "TEAM-IDEMPOTENT" }),
        }),
      );

    expect((await register()).status).toBe(200);
    expect((await register()).status).toBe(200);

    const routes = await runInDurableObject(
      discoveryStub(),
      (instance: DeviceRegistryObject) =>
        instance.linearRoutesFor("TEAM-IDEMPOTENT"),
    );

    expect(routes).toEqual([{ installationId, repositoryId: repository.id }]);
  });

  it("refuses linear routing registration without a valid device bearer token", async () => {
    const app = relay();
    const response = await app.fetch(
      new Request("https://relay.test/device/linear-routing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ linearTeamId: "TEAM-1" }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("upgrades a notification subscription only for a valid device bearer token", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");

    expect((await openNotifications(app, registered.deviceToken)).status).toBe(
      101,
    );
    expect(
      (
        await openNotifications(
          app,
          `${installationId}.${repository.id}.forged`,
        )
      ).status,
    ).toBe(401);
    expect(
      (await app.fetch(new Request("https://relay.test/notifications"))).status,
    ).toBe(426);
  });

  it("never carries webhook payload content, only a type and a source", async () => {
    const app = relay();
    const registered = await registerDevice(app, "serve-state");
    const subscription = await openNotifications(app, registered.deviceToken);
    const socket = subscription.webSocket!;

    socket.accept();

    const wake = nextMessage(socket);

    await sendGithubWebhook(app, "issues", {
      action: "opened",
      installation: { id: installationId },
      repository: { id: repository.id },
      issue: { title: "should never be forwarded", body: "secret body" },
    });

    expect(Object.keys(await wake).sort()).toEqual(["source", "type"]);
  });
});

describe("transcript search relay", () => {
  async function openSearchable(app: ReturnType<typeof relay>) {
    const registered = await registerDevice(app, `state-${Math.random()}`);
    const subscription = await openNotifications(app, registered.deviceToken);
    const socket = subscription.webSocket!;

    socket.accept();

    return socket;
  }

  it("fans a repository-scope request out and merges every sibling's answer", async () => {
    const app = relay();
    const requester = await openSearchable(app);
    const sibling = await openSearchable(app);
    const forwarded = nextMessage(sibling);

    requester.send(
      JSON.stringify({
        type: "transcript.search.request",
        requestId: "search-1",
        scope: "repository",
        query: "hello",
        limit: 10,
      }),
    );

    // 中継先へは要求元自身の局所検索範囲(`local`)へ落として届く。
    expect(await forwarded).toEqual({
      type: "transcript.search.request",
      requestId: "search-1",
      scope: "local",
      query: "hello",
      limit: 10,
    });

    const result = nextMessage(requester);

    sibling.send(
      JSON.stringify({
        type: "transcript.search.result",
        requestId: "search-1",
        entries: [
          {
            jobId: "job-1",
            sequence: 1,
            kind: "model.stream.event",
            content: "hello there",
            createdAt: 1,
          },
        ],
      }),
    );

    expect(await result).toEqual({
      type: "transcript.search.result",
      requestId: "search-1",
      entries: [
        {
          jobId: "job-1",
          sequence: 1,
          kind: "model.stream.event",
          content: "hello there",
          createdAt: 1,
        },
      ],
    });
  });

  it("returns no entries when no sibling server is connected", async () => {
    const app = relay();
    const requester = await openSearchable(app);
    const result = nextMessage(requester);

    requester.send(
      JSON.stringify({
        type: "transcript.search.request",
        requestId: "search-alone",
        scope: "repository",
        query: "hello",
        limit: 10,
      }),
    );

    expect(await result).toEqual({
      type: "transcript.search.result",
      requestId: "search-alone",
      entries: [],
    });
  });

  it("stops waiting on a sibling that never answers and returns what it has", async () => {
    transcriptSearchTimeoutMs = 20;

    const app = relay();
    const requester = await openSearchable(app);
    const sibling = await openSearchable(app);
    const forwarded = nextMessage(sibling);

    requester.send(
      JSON.stringify({
        type: "transcript.search.request",
        requestId: "search-timeout",
        scope: "repository",
        query: "hello",
        limit: 10,
      }),
    );

    await forwarded;

    const result = nextMessage(requester);

    // siblingは意図的に応答しない。

    expect(await result).toEqual({
      type: "transcript.search.result",
      requestId: "search-timeout",
      entries: [],
    });
  });

  it("does not merge a result carrying a requestId the relay never asked for", async () => {
    const app = relay();
    const requester = await openSearchable(app);
    const sibling = await openSearchable(app);
    const forwarded = nextMessage(sibling);

    requester.send(
      JSON.stringify({
        type: "transcript.search.request",
        requestId: "search-real",
        scope: "repository",
        query: "hello",
        limit: 10,
      }),
    );

    await forwarded;

    const result = nextMessage(requester);

    // 要求していない別のrequestIdへの答えは、待機中のどの検索にも合流しない。
    sibling.send(
      JSON.stringify({
        type: "transcript.search.result",
        requestId: "unrelated",
        entries: [
          {
            jobId: "job-x",
            sequence: 1,
            kind: "model.stream.event",
            content: "noise",
            createdAt: 1,
          },
        ],
      }),
    );
    sibling.send(
      JSON.stringify({
        type: "transcript.search.result",
        requestId: "search-real",
        entries: [],
      }),
    );

    expect(await result).toEqual({
      type: "transcript.search.result",
      requestId: "search-real",
      entries: [],
    });
  });
});
