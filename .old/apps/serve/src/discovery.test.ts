import { expect, test } from "bun:test";

import {
  createDiscoveryLoop,
  type DiscoveryPorts,
  type DiscoveryStartResult,
} from "./discovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

function portsOf(
  issues: { number: number; url: string }[],
  matchesByUrl: Record<string, { issueId: string }[]>,
): () => Promise<DiscoveryPorts | null> {
  return async () => ({
    listOpenIssues: async () => issues,
    findLinearIssuesByGitHubIssueUrl: async (url) => matchesByUrl[url] ?? [],
  });
}

function startedJob(): DiscoveryStartResult {
  return {
    status: "started",
    finished: Promise.resolve(),
    close: () => undefined,
  };
}

test("starts exactly one Job for a uniquely matched Linear issue", async () => {
  const started: string[] = [];
  const loop = createDiscoveryLoop({
    createPorts: portsOf(
      [{ number: 28, url: "https://github.com/mikan-919/oriel/issues/28" }],
      {
        "https://github.com/mikan-919/oriel/issues/28": [{ issueId: "L-1" }],
      },
    ),
    startImplementationJob: async ({ linearIssueId }) => {
      started.push(linearIssueId);
      return startedJob();
    },
    pollIntervalMs: 60_000,
  });

  const result = await loop.runOnce();

  expect(started).toEqual(["L-1"]);
  expect(result).toEqual({
    candidatesConsidered: 1,
    jobsStarted: 1,
    ambiguous: 0,
  });
});

test("does not start a Job when multiple Linear issues match, and counts it as ambiguous", async () => {
  const started: string[] = [];
  const loop = createDiscoveryLoop({
    createPorts: portsOf(
      [{ number: 28, url: "https://github.com/mikan-919/oriel/issues/28" }],
      {
        "https://github.com/mikan-919/oriel/issues/28": [
          { issueId: "L-1" },
          { issueId: "L-2" },
        ],
      },
    ),
    startImplementationJob: async ({ linearIssueId }) => {
      started.push(linearIssueId);
      return startedJob();
    },
    pollIntervalMs: 60_000,
  });

  const result = await loop.runOnce();

  expect(started).toEqual([]);
  expect(result).toEqual({
    candidatesConsidered: 1,
    jobsStarted: 0,
    ambiguous: 1,
  });
});

test("skips an issue with no matching Linear issue", async () => {
  const started: string[] = [];
  const loop = createDiscoveryLoop({
    createPorts: portsOf(
      [{ number: 28, url: "https://github.com/mikan-919/oriel/issues/28" }],
      {},
    ),
    startImplementationJob: async ({ linearIssueId }) => {
      started.push(linearIssueId);
      return startedJob();
    },
    pollIntervalMs: 60_000,
  });

  const result = await loop.runOnce();

  expect(started).toEqual([]);
  expect(result).toEqual({
    candidatesConsidered: 0,
    jobsStarted: 0,
    ambiguous: 0,
  });
});

test("becomes a no-op scan when listOpenIssues or createPorts is unavailable", async () => {
  const noPorts = createDiscoveryLoop({
    createPorts: async () => null,
    startImplementationJob: async () => startedJob(),
    pollIntervalMs: 60_000,
  });

  expect(await noPorts.runOnce()).toEqual({
    candidatesConsidered: 0,
    jobsStarted: 0,
    ambiguous: 0,
  });

  const noIssues = createDiscoveryLoop({
    createPorts: async () => ({
      listOpenIssues: async () => null,
      findLinearIssuesByGitHubIssueUrl: async () => [],
    }),
    startImplementationJob: async () => startedJob(),
    pollIntervalMs: 60_000,
  });

  expect(await noIssues.runOnce()).toEqual({
    candidatesConsidered: 0,
    jobsStarted: 0,
    ambiguous: 0,
  });
});

test("does not start a second Job for the same linearIssueId while the first is still in flight", async () => {
  const jobFinished = deferred<void>();
  let startCalls = 0;
  const loop = createDiscoveryLoop({
    createPorts: portsOf(
      [{ number: 28, url: "https://github.com/mikan-919/oriel/issues/28" }],
      {
        "https://github.com/mikan-919/oriel/issues/28": [{ issueId: "L-1" }],
      },
    ),
    startImplementationJob: async () => {
      startCalls += 1;
      return {
        status: "started",
        finished: jobFinished.promise,
        close: () => undefined,
      };
    },
    pollIntervalMs: 60_000,
  });

  await loop.runOnce();
  await loop.runOnce();

  expect(startCalls).toBe(1);

  jobFinished.resolve();
  await Promise.resolve();
  await Promise.resolve();

  await loop.runOnce();

  expect(startCalls).toBe(2);
});

test("coalesces a wake received during an in-progress scan into exactly one follow-up scan", async () => {
  let scanCalls = 0;
  const firstScanGate = deferred<void>();
  const loop = createDiscoveryLoop({
    createPorts: async () => {
      scanCalls += 1;

      if (scanCalls === 1) {
        await firstScanGate.promise;
      }

      return {
        listOpenIssues: async () => [],
        findLinearIssuesByGitHubIssueUrl: async () => [],
      };
    },
    startImplementationJob: async () => startedJob(),
    pollIntervalMs: 60_000,
  });

  loop.start();
  await Promise.resolve();

  const secondWake = loop.wake("github");
  const thirdWake = loop.wake("linear");

  firstScanGate.resolve();
  await secondWake;
  await thirdWake;

  loop.stop();

  // 一回目のscanが走っている間に来た二回のwakeは一回の追いscanへcoalesceされる。
  expect(scanCalls).toBe(2);
});

test("re-scans automatically on the poll interval while started", async () => {
  let scanCalls = 0;
  const loop = createDiscoveryLoop({
    createPorts: async () => {
      scanCalls += 1;
      return {
        listOpenIssues: async () => [],
        findLinearIssuesByGitHubIssueUrl: async () => [],
      };
    },
    startImplementationJob: async () => startedJob(),
    pollIntervalMs: 20,
  });

  loop.start();
  await new Promise((resolve) => setTimeout(resolve, 70));
  loop.stop();

  expect(scanCalls).toBeGreaterThanOrEqual(3);
});

test("wake before start is a no-op", async () => {
  let scanCalls = 0;
  const loop = createDiscoveryLoop({
    createPorts: async () => {
      scanCalls += 1;
      return {
        listOpenIssues: async () => [],
        findLinearIssuesByGitHubIssueUrl: async () => [],
      };
    },
    startImplementationJob: async () => startedJob(),
    pollIntervalMs: 60_000,
  });

  await loop.wake("poll");

  expect(scanCalls).toBe(0);
});
