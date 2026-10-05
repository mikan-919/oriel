import { expect, test } from "bun:test";

import {
  createHowTriggerLoop,
  detectHowTrigger,
  type HowTriggerPorts,
} from "./how-trigger-discovery";

const viewerId = "actor-1";

test("detects an explicit command as the trigger", () => {
  const trigger = detectHowTrigger(
    [
      {
        id: "c1",
        authorId: "human-1",
        body: "/oriel confirm let's proceed",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    viewerId,
  );

  expect(trigger).toEqual({ commentId: "c1", command: true });
});

test("detects a plain mention as a non-command trigger", () => {
  const trigger = detectHowTrigger(
    [
      {
        id: "c1",
        authorId: "human-1",
        body: "hey @oriel what do you think?",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    viewerId,
  );

  expect(trigger).toEqual({ commentId: "c1", command: false });
});

test("returns null when the latest comment does not mention or command", () => {
  const trigger = detectHowTrigger(
    [
      {
        id: "c1",
        authorId: "human-1",
        body: "just a regular comment",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    viewerId,
  );

  expect(trigger).toBeNull();
});

test("returns null when the actor already replied to the latest trigger", () => {
  const trigger = detectHowTrigger(
    [
      {
        id: "c1",
        authorId: "human-1",
        body: "@oriel please help",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "c2",
        authorId: viewerId,
        body: "Noted.",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ],
    viewerId,
  );

  expect(trigger).toBeNull();
});

test("orders by createdAt rather than array order", () => {
  const trigger = detectHowTrigger(
    [
      {
        id: "c2",
        authorId: "human-1",
        body: "/oriel confirm go ahead",
        createdAt: "2026-01-01T00:02:00.000Z",
      },
      {
        id: "c1",
        authorId: viewerId,
        body: "Noted.",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ],
    viewerId,
  );

  expect(trigger).toEqual({ commentId: "c2", command: true });
});

function fakePorts(overrides: Partial<HowTriggerPorts> = {}): HowTriggerPorts {
  return {
    listOpenIssues: async () => [],
    findLinearIssuesByGitHubIssueUrl: async () => [],
    readLinearIssue: async () => null,
    listLinearComments: async () => [],
    getLinearViewerId: async () => viewerId,
    ...overrides,
  };
}

test("starts a Job for a Triage-linked issue with a triggering comment", async () => {
  const started: unknown[] = [];
  const loop = createHowTriggerLoop({
    createPorts: async () =>
      fakePorts({
        listOpenIssues: async () => [
          { number: 34, url: "https://github.com/acme/widgets/issues/34" },
        ],
        findLinearIssuesByGitHubIssueUrl: async () => [{ issueId: "lin-1" }],
        readLinearIssue: async () => ({
          title: "HOW",
          description: "draft",
          stateName: "Triage",
        }),
        listLinearComments: async () => [
          {
            id: "c1",
            authorId: "human-1",
            body: "/oriel confirm",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    startHowConfirmationJob: async (input) => {
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
    {
      issueNumber: 34,
      linearIssueId: "lin-1",
      trigger: { commentId: "c1", command: true },
    },
  ]);
});

test("skips an issue with no unambiguous Linear link", async () => {
  const started: unknown[] = [];
  const loop = createHowTriggerLoop({
    createPorts: async () =>
      fakePorts({
        listOpenIssues: async () => [
          { number: 34, url: "https://github.com/acme/widgets/issues/34" },
        ],
        findLinearIssuesByGitHubIssueUrl: async () => [
          { issueId: "lin-1" },
          { issueId: "lin-2" },
        ],
      }),
    startHowConfirmationJob: async (input) => {
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

test("skips a Linear issue that already left Triage", async () => {
  const started: unknown[] = [];
  const loop = createHowTriggerLoop({
    createPorts: async () =>
      fakePorts({
        listOpenIssues: async () => [
          { number: 34, url: "https://github.com/acme/widgets/issues/34" },
        ],
        findLinearIssuesByGitHubIssueUrl: async () => [{ issueId: "lin-1" }],
        readLinearIssue: async () => ({
          title: "HOW",
          description: "confirmed",
          stateName: "Todo",
        }),
        listLinearComments: async () => [
          {
            id: "c1",
            authorId: "human-1",
            body: "@oriel status?",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    startHowConfirmationJob: async (input) => {
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
