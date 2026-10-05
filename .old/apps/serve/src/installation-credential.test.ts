import { expect, test } from "bun:test";

import type {
  InstallationTokenPurpose,
  InstallationTokenResponse,
} from "@mikan-919/oriel-contracts";

import type { DeviceTokenStore } from "./device-registration";
import { createInstallationGitCredentialResolver } from "./installation-credential";

const deviceToken = "7.11.device-token";
const repositoryId = 11;

function resolver(options: {
  token?: string | null;
  storedToken?: string | null;
  repositoryIdOverride?: number;
  purposeOverride?: InstallationTokenPurpose;
  throws?: boolean;
}) {
  const requested: InstallationTokenPurpose[] = [];
  const resolve = createInstallationGitCredentialResolver({
    relay: {
      requestInstallationToken: async (
        _token: string,
        purpose: InstallationTokenPurpose,
      ): Promise<InstallationTokenResponse | null> => {
        requested.push(purpose);

        if (options.throws === true) {
          throw new Error("the relay is unreachable");
        }

        const token = options.token ?? "installation-token";

        return options.token === null
          ? null
          : {
              token,
              expiresAt: "2026-08-14T00:10:00Z",
              purpose: options.purposeOverride ?? purpose,
              installationId: 7,
              repositoryId: options.repositoryIdOverride ?? repositoryId,
            };
      },
    },
    tokenStore: fakeStore(
      options.storedToken === undefined ? deviceToken : options.storedToken,
    ),
    repositoryId,
  });

  return { requested, resolve };
}

function fakeStore(token: string | null): DeviceTokenStore {
  return { get: async () => token, set: async () => {} };
}

test("the checkpoint push asks only for the implementation permission set", async () => {
  const context = resolver({});

  expect(await context.resolve()).toEqual({
    username: "x-access-token",
    token: "installation-token",
  });
  expect(context.requested).toEqual(["implementation"]);

  // 送信ごとに取り直し、どこにも保存しない。
  expect(await context.resolve()).not.toBeNull();
  expect(context.requested).toEqual(["implementation", "implementation"]);
});

test("Git receives no credential when the relay cannot scope one", async () => {
  expect(await resolver({ storedToken: null }).resolve()).toBeNull();
  expect(await resolver({ token: null }).resolve()).toBeNull();
  expect(await resolver({ throws: true }).resolve()).toBeNull();
  expect(
    await resolver({ repositoryIdOverride: repositoryId + 1 }).resolve(),
  ).toBeNull();
  // 用途の違うtokenは、実装が必要としない権限を持ちうるため使わない。
  expect(
    await resolver({ purposeOverride: "pull_request" }).resolve(),
  ).toBeNull();
});
