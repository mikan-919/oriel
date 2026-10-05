import { expect, test } from "bun:test";
import type { InstallationTokenPurpose } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import { createInstallationOctokitResolver } from "./installation-octokit";

const repositoryId = 11;
const deviceToken = "7.11.device-token";

function tokenStore(token: string | null): DeviceTokenStore {
  return { set: async () => {}, get: async () => token };
}

function resolver(options: {
  token: string | null;
  storedToken?: string | null;
  repositoryIdOverride?: number;
  purpose?: InstallationTokenPurpose;
  purposeOverride?: InstallationTokenPurpose;
  throws?: boolean;
}) {
  const authorizations: string[] = [];
  const requested: { deviceToken: string; purpose: string }[] = [];
  const purpose = options.purpose ?? "issue_conversation";
  const resolve = createInstallationOctokitResolver({
    relay: {
      requestInstallationToken: async (
        token: string,
        requestedPurpose: InstallationTokenPurpose,
      ) => {
        requested.push({ deviceToken: token, purpose: requestedPurpose });

        if (options.throws === true) {
          throw new Error("the relay is unreachable");
        }

        return options.token === null
          ? null
          : {
              token: options.token,
              expiresAt: "2026-08-14T00:10:00Z",
              purpose: options.purposeOverride ?? requestedPurpose,
              installationId: 7,
              repositoryId: options.repositoryIdOverride ?? repositoryId,
            };
      },
    },
    tokenStore: tokenStore(
      options.storedToken === undefined ? deviceToken : options.storedToken,
    ),
    repositoryId,
    purpose,
    newOctokit: (auth) => {
      authorizations.push(auth);
      return {} as Octokit;
    },
  });

  return { resolve, authorizations, requested };
}

test("the device token buys a short lived installation token for the Octokit", async () => {
  const context = resolver({ token: "installation-token" });

  expect(await context.resolve()).not.toBeNull();
  expect(context.requested).toEqual([
    { deviceToken, purpose: "issue_conversation" },
  ]);
  expect(context.authorizations).toEqual(["installation-token"]);

  // 呼び出しごとに取り直し、保存しない。
  await context.resolve();

  expect(context.authorizations).toEqual([
    "installation-token",
    "installation-token",
  ]);
});

test("each purpose asks the relay for its own permission set", async () => {
  const admission = resolver({
    token: "installation-token",
    purpose: "admission",
  });

  expect(await admission.resolve()).not.toBeNull();
  expect(admission.requested).toEqual([{ deviceToken, purpose: "admission" }]);

  const implementation = resolver({
    token: "installation-token",
    purpose: "implementation",
  });

  expect(await implementation.resolve()).not.toBeNull();
  expect(implementation.requested).toEqual([
    { deviceToken, purpose: "implementation" },
  ]);
});

test("external writes fail closed without a device token or a relay answer", async () => {
  expect(
    await resolver({
      token: "installation-token",
      storedToken: null,
    }).resolve(),
  ).toBeNull();
  expect(await resolver({ token: null }).resolve()).toBeNull();
  expect(
    await resolver({ token: "installation-token", throws: true }).resolve(),
  ).toBeNull();
  expect(
    await resolver({
      token: "installation-token",
      repositoryIdOverride: repositoryId + 1,
    }).resolve(),
  ).toBeNull();
  // 要求した用途と違うtokenは、広い権限かもしれないため使わない。
  expect(
    await resolver({
      token: "installation-token",
      purpose: "admission",
      purposeOverride: "implementation",
    }).resolve(),
  ).toBeNull();
});
