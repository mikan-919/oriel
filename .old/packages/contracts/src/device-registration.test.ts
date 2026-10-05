import { expect, test } from "bun:test";

import {
  parseDeviceRegistrationCallback,
  parseDeviceTokenExchangeResponse,
  parseOwnershipServerMessage,
} from "./index";

const registeredRepository = {
  installationId: 7,
  repositoryId: 11,
  repository: { owner: "mikan-919", name: "oriel" },
};

test("callback carries only the one-time code and state", () => {
  expect(
    parseDeviceRegistrationCallback({ code: "one-time", state: "state" }),
  ).toEqual({ code: "one-time", state: "state" });

  expect(() =>
    parseDeviceRegistrationCallback({
      code: "one-time",
      state: "state",
      deviceToken: "leaked",
    }),
  ).toThrow();
});

test("a registration exchange binds the token to one installation repository", () => {
  const response = {
    purpose: "registration" as const,
    deviceId: "device-1",
    deviceToken: "token",
    cancellationToken: "cancellation",
    cancellationExpiresAt: 1_000,
    ...registeredRepository,
  };

  expect(parseDeviceTokenExchangeResponse(response)).toEqual(response);
  expect(() =>
    parseDeviceTokenExchangeResponse({ ...response, repositoryId: 0 }),
  ).toThrow();
});

test("management exchanges carry the finished result instead of a reusable session", () => {
  const revocation = {
    purpose: "revocation" as const,
    ...registeredRepository,
    deviceId: "device-1",
    revokedAt: 1_000,
  };

  expect(parseDeviceTokenExchangeResponse(revocation)).toEqual(revocation);
  expect(() =>
    parseDeviceTokenExchangeResponse({
      ...revocation,
      managementToken: "session",
    }),
  ).toThrow();

  const installations = {
    purpose: "installations" as const,
    installations: [
      {
        installationId: 7,
        account: "mikan-919",
        canAdminister: true,
        repositories: [
          {
            repositoryId: 11,
            repository: { owner: "mikan-919", name: "oriel" },
          },
        ],
      },
    ],
  };

  expect(parseDeviceTokenExchangeResponse(installations)).toEqual(
    installations,
  );
});

test("ownership messages only carry relay issued acquisition IDs", () => {
  const acquired = {
    type: "ownership.acquired" as const,
    leaseId: "lease-1",
    heartbeatIntervalMs: 1_000,
    heartbeatExpiryMs: 5_000,
  };

  expect(parseOwnershipServerMessage(acquired)).toEqual(acquired);
  expect(parseOwnershipServerMessage({ type: "ownership.expired" })).toEqual({
    type: "ownership.expired",
  });
  expect(parseOwnershipServerMessage({ type: "ownership.revoked" })).toEqual({
    type: "ownership.revoked",
  });
  expect(() =>
    parseOwnershipServerMessage({ type: "ownership.acquired" }),
  ).toThrow();
});
