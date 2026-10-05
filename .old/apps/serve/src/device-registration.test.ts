import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  createDeviceRegistrationFlow,
  type DeviceTokenStore,
} from "./device-registration";
import { openServeLocalState } from "./local-state";
import {
  createPendingCancellationStore,
  type PendingCancellationStore,
} from "./pending-cancellations";
import { createRelayDeviceClient, type RelayFetch } from "./relay-client";

const installationId = 7;
const repository = { id: 11, owner: "mikan-919", name: "oriel" };
const authorizeEndpoint = new URL("https://relay.test/device/authorize");
const redirectUri = new URL("http://127.0.0.1:49152/device/callback");

type Purpose = "installations" | "registration" | "device_list" | "revocation";

interface FakeRelayOptions {
  /** repositoryを取り違えて返すrelayを再現する。 */
  repositoryIdOverride?: number;
  cancellationOutcome?: () => "cancelled" | "refused" | "unknown";
  /** installationを現在管理できないGitHub userを再現する。 */
  administrable?: () => boolean;
  now?: () => number;
}

/** relayのHTTP contractに合わせたfake。実物はworkerd上のvitestで検証する。 */
function fakeRelay({
  repositoryIdOverride,
  cancellationOutcome = () => "cancelled" as const,
  administrable = () => true,
  now = () => 1_000,
}: FakeRelayOptions = {}) {
  const codes = new Map<
    string,
    { codeChallenge: string; purpose: Purpose; deviceId: string | null }
  >();
  const devices = new Map<
    string,
    { cancellationToken: string; revokedAt: number | null }
  >();
  const target = {
    installationId,
    repositoryId: repositoryIdOverride ?? repository.id,
    repository: { owner: repository.owner, name: repository.name },
  };

  const relayFetch: RelayFetch = async (input, init) => {
    const url = new URL(input);
    const body =
      init?.body === undefined ? {} : JSON.parse(String(init.body ?? "{}"));
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.pathname === "/device/cancellation") {
      if (cancellationOutcome() === "unknown") {
        return new Response("Service Unavailable", { status: 503 });
      }

      const device = devices.get(body.deviceId);

      if (
        cancellationOutcome() === "refused" ||
        device === undefined ||
        device.cancellationToken !== body.cancellationToken
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      device.revokedAt = now();
      return json({ deviceId: body.deviceId, cancelled: true });
    }

    const issued = codes.get(body.code);
    codes.delete(body.code);

    if (
      issued === undefined ||
      createHash("sha256").update(body.codeVerifier).digest("base64url") !==
        issued.codeChallenge
    ) {
      return new Response("Bad Request", { status: 400 });
    }

    if (issued.purpose === "installations") {
      return json({
        purpose: "installations",
        installations: [
          {
            installationId,
            account: repository.owner,
            canAdminister: administrable(),
            repositories: [
              {
                repositoryId: repository.id,
                repository: { owner: repository.owner, name: repository.name },
              },
            ],
          },
        ],
      });
    }

    if (issued.purpose === "device_list") {
      return json({
        purpose: "device_list",
        ...target,
        devices: [...devices].map(([deviceId, device]) => ({
          deviceId,
          installationId,
          repositoryId: repository.id,
          repository: { owner: repository.owner, name: repository.name },
          registeredAt: now(),
          revokedAt: device.revokedAt,
        })),
      });
    }

    if (issued.purpose === "revocation") {
      const device =
        issued.deviceId === null ? undefined : devices.get(issued.deviceId);

      if (device === undefined) {
        return new Response("Not Found", { status: 404 });
      }

      device.revokedAt ??= now();
      return json({
        purpose: "revocation",
        ...target,
        deviceId: issued.deviceId,
        revokedAt: device.revokedAt,
      });
    }

    const deviceId = randomUUID();
    const cancellationToken = `cancellation-${deviceId}`;
    devices.set(deviceId, { cancellationToken, revokedAt: null });

    return json({
      purpose: "registration",
      deviceId,
      deviceToken: `device-token-${deviceId}`,
      cancellationToken,
      cancellationExpiresAt: now() + 120_000,
      ...target,
    });
  };

  return {
    devices,
    client: createRelayDeviceClient({
      baseUrl: "https://relay.test",
      fetch: relayFetch,
    }),
    /**
     * browserがGitHub loginを終えてlocalhostへ戻るまでを再現する。
     * 失効と一覧はその時点の管理権限が無ければrelayがcodeを出さない。
     */
    authorizeInBrowser(authorizeUrl: URL): URL | null {
      const purpose = (authorizeUrl.searchParams.get("purpose") ??
        "registration") as Purpose;

      if (
        (purpose === "revocation" || purpose === "device_list") &&
        !administrable()
      ) {
        return null;
      }

      const code = `code-${randomUUID()}`;
      codes.set(code, {
        codeChallenge: authorizeUrl.searchParams.get("code_challenge") ?? "",
        purpose,
        deviceId: authorizeUrl.searchParams.get("device_id"),
      });

      const callbackUrl = new URL(
        authorizeUrl.searchParams.get("redirect_uri") ?? "",
      );
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set(
        "state",
        authorizeUrl.searchParams.get("state") ?? "",
      );

      return callbackUrl;
    },
  };
}

function setup(
  options: FakeRelayOptions & {
    tokenStore?: DeviceTokenStore;
    cancellationStore?: PendingCancellationStore;
    relay?: ReturnType<typeof fakeRelay>;
  } = {},
) {
  const stored: { repositoryId: number; deviceToken: string }[] = [];
  const relay = options.relay ?? fakeRelay(options);
  const flow = createDeviceRegistrationFlow({
    relay: relay.client,
    tokenStore:
      options.tokenStore ??
      ({
        set: async (input) => {
          stored.push(input);
        },
        get: async () => stored[0]?.deviceToken ?? null,
      } satisfies DeviceTokenStore),
    authorizeEndpoint,
    redirectUri,
    cancellationStore: options.cancellationStore,
    now: options.now ?? (() => 1_000),
  });

  return { flow, relay, stored };
}

async function run(
  context: ReturnType<typeof setup>,
  purpose: Purpose = "registration",
  deviceId?: string,
) {
  const { authorizeUrl } = context.flow.begin({
    purpose,
    installationId,
    repositoryId: repository.id,
    deviceId,
  });
  const callbackUrl = context.relay.authorizeInBrowser(authorizeUrl);

  return callbackUrl === null
    ? ({ status: "refused_by_github" } as const)
    : context.flow.complete(callbackUrl);
}

test("registration starts from localhost and stores the token in the credential store", async () => {
  const context = setup();
  const { authorizeUrl } = context.flow.begin({
    purpose: "registration",
    installationId,
    repositoryId: repository.id,
  });

  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizeUrl.searchParams.get("purpose")).toBe("registration");

  const callbackUrl = context.relay.authorizeInBrowser(authorizeUrl)!;

  expect([...callbackUrl.searchParams.keys()].sort()).toEqual([
    "code",
    "state",
  ]);

  const result = await context.flow.complete(callbackUrl);

  expect(result).toEqual({
    status: "registered",
    deviceId: expect.any(String),
  });
  expect(context.stored).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(
    context.stored[0]?.deviceToken ?? "unreachable",
  );
});

test("the installation and repository choices come from GitHub instead of typed IDs", async () => {
  const context = setup();
  const { authorizeUrl } = context.flow.begin({ purpose: "installations" });

  expect(authorizeUrl.searchParams.get("purpose")).toBe("installations");
  expect(authorizeUrl.searchParams.has("installation_id")).toBe(false);

  expect(
    await context.flow.complete(
      context.relay.authorizeInBrowser(authorizeUrl)!,
    ),
  ).toEqual({
    status: "installations",
    installations: [
      {
        installationId,
        account: repository.owner,
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

test("a callback with a foreign, reused, or overloaded state is refused", async () => {
  const context = setup();
  const { authorizeUrl } = context.flow.begin({
    purpose: "registration",
    installationId,
    repositoryId: repository.id,
  });
  const callbackUrl = context.relay.authorizeInBrowser(authorizeUrl)!;
  const forged = new URL(callbackUrl);
  forged.searchParams.set("state", "other-state");

  expect(await context.flow.complete(forged)).toEqual({
    status: "rejected",
    reason: "unknown_state",
  });

  const smuggled = new URL(callbackUrl);
  smuggled.searchParams.set("device_token", "smuggled");

  expect(await context.flow.complete(smuggled)).toEqual({
    status: "rejected",
    reason: "invalid_callback",
  });
  expect(await context.flow.complete(callbackUrl)).toMatchObject({
    status: "registered",
  });
  expect(await context.flow.complete(callbackUrl)).toEqual({
    status: "rejected",
    reason: "unknown_state",
  });
});

test("every listing and revocation needs a fresh GitHub login that still administers the installation", async () => {
  let administrable = true;
  const context = setup({ administrable: () => administrable });
  const registered = await run(context);
  const deviceId =
    registered.status === "registered" ? registered.deviceId : "";

  administrable = false;

  expect(await run(context, "device_list")).toEqual({
    status: "refused_by_github",
  });
  expect(await run(context, "revocation", deviceId)).toEqual({
    status: "refused_by_github",
  });
  expect([...context.relay.devices.values()][0]?.revokedAt).toBeNull();

  administrable = true;

  expect(await run(context, "device_list")).toMatchObject({
    status: "devices",
    devices: [{ deviceId, revokedAt: null }],
  });
  expect(await run(context, "revocation", deviceId)).toMatchObject({
    status: "revoked",
    deviceId,
  });
  expect([...context.relay.devices.values()][0]?.revokedAt).toEqual(
    expect.any(Number),
  );
});

test("a credential store failure cancels the issued device and fails closed", async () => {
  const context = setup({
    tokenStore: {
      set: async () => {
        throw new Error("Secret Service is unavailable");
      },
      get: async () => null,
    },
  });

  expect(await run(context)).toEqual({
    status: "rejected",
    reason: "credential_store_unavailable",
  });
  expect(context.stored).toHaveLength(0);
  expect([...context.relay.devices.values()][0]?.revokedAt).toEqual(
    expect.any(Number),
  );
  expect(context.flow.pendingCancellations()).toEqual([]);
});

test("an unconfirmed cancellation survives a serve restart and converges on resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriel-cancellation-"));
  const database = openServeLocalState(join(directory, "serve.sqlite"));
  let outcome: "cancelled" | "unknown" = "unknown";
  const relay = fakeRelay({ cancellationOutcome: () => outcome });
  const failingStore: DeviceTokenStore = {
    set: async () => {
      throw new Error("Secret Service is unavailable");
    },
    get: async () => null,
  };

  try {
    const before = setup({
      relay,
      tokenStore: failingStore,
      cancellationStore: createPendingCancellationStore(database),
    });
    const result = await run(before);

    expect(result).toEqual({
      status: "reconciliation_required",
      deviceId: expect.any(String),
    });
    expect(before.flow.pendingCancellations()).toHaveLength(1);

    // 再起動しても取消証明を失わない。
    database.close();
    const reopened = openServeLocalState(join(directory, "serve.sqlite"));
    const after = setup({
      relay,
      tokenStore: failingStore,
      cancellationStore: createPendingCancellationStore(reopened),
    });

    expect(after.flow.pendingCancellations()).toEqual([
      {
        deviceId: expect.any(String),
        cancellationToken: expect.any(String),
        cancellationExpiresAt: expect.any(Number),
      },
    ]);

    outcome = "cancelled";

    expect(await after.flow.resumePendingCancellations()).toEqual([]);
    expect([...relay.devices.values()][0]?.revokedAt).toEqual(
      expect.any(Number),
    );
    reopened.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("a relay that answers for another repository does not register a device", async () => {
  const context = setup({ repositoryIdOverride: repository.id + 1 });

  expect(await run(context)).toEqual({
    status: "rejected",
    reason: "registration_target_mismatch",
  });
  expect(context.stored).toHaveLength(0);
  expect([...context.relay.devices.values()][0]?.revokedAt).toEqual(
    expect.any(Number),
  );
});
