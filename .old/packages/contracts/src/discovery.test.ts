import { expect, test } from "bun:test";

import {
  parseLinearRoutingRequest,
  parseLinearRoutingResponse,
  parseNotificationServerMessage,
} from "./index";

test("wake notifications carry only a source, never webhook payload content", () => {
  const wake = {
    type: "notification.wake" as const,
    source: "github" as const,
  };

  expect(parseNotificationServerMessage(wake)).toEqual(wake);
  expect(
    parseNotificationServerMessage({
      type: "notification.wake",
      source: "linear",
    }),
  ).toEqual({ type: "notification.wake", source: "linear" });

  expect(() =>
    parseNotificationServerMessage({
      type: "notification.wake",
      source: "github",
      body: "leaked issue body",
    }),
  ).toThrow();
  expect(() =>
    parseNotificationServerMessage({
      type: "notification.wake",
      source: "slack",
    }),
  ).toThrow();
});

test("linear routing carries only the team ID, not credentials", () => {
  const request = { linearTeamId: "TEAM-1" };

  expect(parseLinearRoutingRequest(request)).toEqual(request);
  expect(() =>
    parseLinearRoutingRequest({ ...request, linearToken: "leaked" }),
  ).toThrow();
  expect(() => parseLinearRoutingRequest({ linearTeamId: "" })).toThrow();

  const response = {
    linearTeamId: "TEAM-1",
    installationId: 7,
    repositoryId: 11,
  };

  expect(parseLinearRoutingResponse(response)).toEqual(response);
  expect(() =>
    parseLinearRoutingResponse({ ...response, repositoryId: 0 }),
  ).toThrow();
});
