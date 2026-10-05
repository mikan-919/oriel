import { expect, test } from "bun:test";

import {
  createWhatTriggerLoop,
  detectWhatTrigger,
  type WhatTriggerPorts,
} from "./what-trigger-discovery";

const actorLogin = "oriel-bot";

test("detects an explicit command as the trigger", () => {
  const trigger = detectWhatTrigger(
    [{ id: 1, authorLogin: "human", body: "/oriel confirm let's proceed" }],
    actorLogin,
  );

  expect(trigger).toEqual({ commentId: 1, command: true });
});

test("detects a plain mention as a non-command trigger", () => {
  const trigger = detectWhatTrigger(
    [{ id: 1, authorLogin: "human", body: "hey @oriel what do you think?" }],
    actorLogin,
  );

  expect(trigger).toEqual({ commentId: 1, command: false });
});

test("returns null when the latest comment does not mention or command", () => {
  const trigger = detectWhatTrigger(
    [{ id: 1, authorLogin: "human", body: "just a regular comment" }],
    actorLogin,
  );

  expect(trigger).toBeNull();
});

test("returns null when the actor already replied to the latest trigger", () => {
  const trigger = detectWhatTrigger(
    [
      { id: 1, authorLogin: "human", body: "@oriel please help" },
      { id: 2, authorLogin: actorLogin, body: "Noted." },
    ],
    actorLogin,
  );

  expect(trigger).toBeNull();
});

test("re-triggers on a fresh comment posted after the actor's last reply", () => {
  const trigger = detectWhatTrigger(
    [
      { id: 1, authorLogin: "human", body: "@oriel please help" },
      { id: 2, authorLogin: actorLogin, body: "Noted." },
      { id: 3, authorLogin: "human", body: "/oriel confirm go ahead" },
    ],
    actorLogin,
  );

  expect(trigger).toEqual({ commentId: 3, command: true });
});

function fakePorts(
  overrides: Partial<WhatTriggerPorts> = {},
): WhatTriggerPorts {
  return {
    listOpenIssues: async () => [],
    listIssueComments: async () => [],
    getActorLogin: async () => actorLogin,
    findLinearIssuesByGitHubIssueUrl: async () => [],
    ...overrides,
  };
}

test("starts a Job for an unlinked issue with a triggering comment", async () => {
  const started: { issueNumber: number; trigger: unknown }[] = [];
  const loop = createWhatTriggerLoop({
    createPorts: async () =>
      fakePorts({
        listOpenIssues: async () => [
          { number: 28, url: "https://github.com/acme/widgets/issues/28" },
        ],
        listIssueComments: async () => [
          { id: 1, authorLogin: "human", body: "/oriel confirm" },
        ],
        findLinearIssuesByGitHubIssueUrl: async () => [],
      }),
    startWhatConfirmationJob: async (input) => {
      started.push(input);
      return {
        status: "started",
        finished: Promise.resolve(),
        close: () => {},
      };
    },
    pollIntervalMs: 60_000,
  });

  const result = await loop.runOnce();

  expect(result).toEqual({ candidatesConsidered: 1, jobsStarted: 1 });
  expect(started).toEqual([
    { issueNumber: 28, trigger: { commentId: 1, command: true } },
  ]);
});

test("skips an issue that is already linked to a Linear issue", async () => {
  const started: unknown[] = [];
  const loop = createWhatTriggerLoop({
    createPorts: async () =>
      fakePorts({
        listOpenIssues: async () => [
          { number: 28, url: "https://github.com/acme/widgets/issues/28" },
        ],
        listIssueComments: async () => [
          { id: 1, authorLogin: "human", body: "@oriel hi" },
        ],
        findLinearIssuesByGitHubIssueUrl: async () => [{ issueId: "already" }],
      }),
    startWhatConfirmationJob: async (input) => {
      started.push(input);
      return {
        status: "started",
        finished: Promise.resolve(),
        close: () => {},
      };
    },
    pollIntervalMs: 60_000,
  });

  const result = await loop.runOnce();

  expect(result).toEqual({ candidatesConsidered: 0, jobsStarted: 0 });
  expect(started).toEqual([]);
});

test("does not re-trigger an issue the actor already answered", async () => {
  const started: unknown[] = [];
  const loop = createWhatTriggerLoop({
    createPorts: async () =>
      fakePorts({
        listOpenIssues: async () => [
          { number: 28, url: "https://github.com/acme/widgets/issues/28" },
        ],
        listIssueComments: async () => [
          { id: 1, authorLogin: "human", body: "@oriel hi" },
          { id: 2, authorLogin: actorLogin, body: "Noted." },
        ],
      }),
    startWhatConfirmationJob: async (input) => {
      started.push(input);
      return {
        status: "started",
        finished: Promise.resolve(),
        close: () => {},
      };
    },
    pollIntervalMs: 60_000,
  });

  const result = await loop.runOnce();

  expect(result).toEqual({ candidatesConsidered: 0, jobsStarted: 0 });
  expect(started).toEqual([]);
});
