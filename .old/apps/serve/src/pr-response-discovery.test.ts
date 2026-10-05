import { expect, test } from "bun:test";
import { identity } from "@mikan-919/oriel-identity";

import type { PrResponseCheckFailureStore } from "./pr-response-check-failures";
import { prResponseCheckFailureLimit } from "./pr-response-check-failures";
import {
  createPrResponseLoop,
  type PrResponseCandidatePullRequest,
  type PrResponseLogEvent,
  type PrResponseLoopOptions,
  type PrResponsePorts,
  type PrResponseStartResult,
} from "./pr-response-discovery";
import type {
  PrResponseCheckStatus,
  PrResponseComment,
  PrResponseReview,
  PrResponseReviewComment,
} from "./pr-response-admission";

const repositoryId = 11;
const approvalFingerprint = "a".repeat(64);
const headRef = `${identity.codeName}/ENG-12-gh-28-${approvalFingerprint}`;

const candidate: PrResponseCandidatePullRequest = {
  number: 42,
  headRef,
  baseRef: "main",
  headOid: "1111111111111111111111111111111111111111",
};

const humanReview: PrResponseReview = {
  authorIsActor: false,
  state: "CHANGES_REQUESTED",
  submittedAt: "2026-08-20T00:00:00Z",
  body: "please fix the guard",
};

/** 回数だけを保つcheck失敗の記録。SQLは`pr-response-check-failures.test.ts`が見る。 */
function fakeCheckFailures(
  initial: Record<string, number> = {},
): PrResponseCheckFailureStore & { entries: () => Record<string, number> } {
  const counts = new Map(Object.entries(initial));
  const key = (
    targetRepositoryId: number,
    canonicalBranch: string,
    checkName: string,
  ) => `${targetRepositoryId}/${canonicalBranch}/${checkName}`;

  return {
    count: (...target) => counts.get(key(...target)) ?? 0,
    increment: (...target) => {
      const next = (counts.get(key(...target)) ?? 0) + 1;

      counts.set(key(...target), next);

      return next;
    },
    reset: (...target) => counts.set(key(...target), 0),
    entries: () => Object.fromEntries(counts),
  };
}

interface PortCalls {
  listedFor: number[];
}

function fakePorts(
  options: {
    pullRequests?: PrResponseCandidatePullRequest[] | null;
    reviews?: PrResponseReview[] | null;
    comments?: PrResponseComment[] | null;
    reviewComments?: PrResponseReviewComment[] | null;
    checkStatuses?: PrResponseCheckStatus[] | null;
  } = {},
): { ports: PrResponsePorts; calls: PortCalls } {
  const calls: PortCalls = { listedFor: [] };
  // 読めなかった(null)と、読めて空だった(未指定)を取り違えない。
  const or = <T>(configured: T[] | null | undefined, fallback: T[]) =>
    configured === undefined ? fallback : configured;

  return {
    calls,
    ports: {
      listOpenPullRequests: async () => or(options.pullRequests, [candidate]),
      listReviews: async (prNumber) => {
        calls.listedFor.push(prNumber);

        return or(options.reviews, []);
      },
      listComments: async () => or(options.comments, []),
      listReviewComments: async () => or(options.reviewComments, []),
      listRequiredCheckStatuses: async () => or(options.checkStatuses, []),
    },
  };
}

type StartPrResponseJobInput = Parameters<
  PrResponseLoopOptions["startPrResponseJob"]
>[0];

function loop(
  ports: PrResponsePorts | null,
  options: {
    checkFailures?: PrResponseCheckFailureStore;
    start?: (input: StartPrResponseJobInput) => Promise<PrResponseStartResult>;
  } = {},
) {
  const startInputs: StartPrResponseJobInput[] = [];
  const logs: PrResponseLogEvent[] = [];
  const scanner = createPrResponseLoop({
    createPorts: async () => ports,
    repositoryId,
    checkFailures: options.checkFailures ?? fakeCheckFailures(),
    startPrResponseJob: async (input) => {
      startInputs.push(input);

      return (
        (await options.start?.(input)) ?? {
          status: "started",
          finished: Promise.resolve(),
          close: () => {},
        }
      );
    },
    pollIntervalMs: 60_000,
    log: (event) => logs.push(event),
  });

  return { scanner, startInputs, logs };
}

test("a head ref outside the canonical naming is not a candidate at all", async () => {
  const { ports, calls } = fakePorts({
    pullRequests: [
      { ...candidate, headRef: "feature/manual-branch" },
      {
        ...candidate,
        number: 43,
        headRef: `${identity.codeName}/no-fingerprint`,
      },
    ],
  });
  const { scanner, startInputs } = loop(ports);

  expect(await scanner.runOnce()).toEqual({
    candidatesConsidered: 0,
    jobsStarted: 0,
  });
  // 対象外のPRについては、現在値の読み直しすら行わない。
  expect(calls.listedFor).toEqual([]);
  expect(startInputs).toEqual([]);
});

test("a candidate whose current values cannot be read is skipped without being counted", async () => {
  for (const unreadable of [
    { reviews: null },
    { comments: null },
    { reviewComments: null },
    { checkStatuses: null },
  ]) {
    const { ports } = fakePorts(unreadable);
    const { scanner, startInputs } = loop(ports);

    // fail closed: 読めない現在値からtriggerを推測しない。
    expect(await scanner.runOnce()).toEqual({
      candidatesConsidered: 0,
      jobsStarted: 0,
    });
    expect(startInputs).toEqual([]);
  }
});

test("an unreachable boundary or Pull Request list ends the scan harmlessly", async () => {
  for (const ports of [null, fakePorts({ pullRequests: null }).ports]) {
    const { scanner, startInputs } = loop(ports);

    expect(await scanner.runOnce()).toEqual({
      candidatesConsidered: 0,
      jobsStarted: 0,
    });
    expect(startInputs).toEqual([]);
  }
});

test("a candidate with no new activity is considered but starts no Job", async () => {
  const { ports } = fakePorts();
  const { scanner, startInputs } = loop(ports);

  expect(await scanner.runOnce()).toEqual({
    candidatesConsidered: 1,
    jobsStarted: 0,
  });
  expect(startInputs).toEqual([]);
});

test("a changes-requested review starts a Job for the target recovered from the head ref", async () => {
  const { ports } = fakePorts({ reviews: [humanReview] });
  const { scanner, startInputs } = loop(ports);

  expect(await scanner.runOnce()).toEqual({
    candidatesConsidered: 1,
    jobsStarted: 1,
  });
  expect(startInputs).toEqual([
    {
      prNumber: 42,
      headRef,
      baseRef: "main",
      headOid: candidate.headOid,
      // 対象Workflowと承認指紋は、clientの申告ではなくbranch名から復元する。
      githubIssueNumber: 28,
      approvalFingerprint,
      trigger: {
        kind: "review",
        body: "please fix the guard",
        comments: [],
      },
    },
  ]);
});

test("a check that turned green resets its consecutive failure count", async () => {
  const checkFailures = fakeCheckFailures({
    [`${repositoryId}/${headRef}/typecheck`]: 2,
    [`${repositoryId}/${headRef}/test`]: 2,
  });
  const { ports } = fakePorts({
    checkStatuses: [
      { checkName: "typecheck", conclusion: "success", summary: "" },
      // まだ走っているcheckは、成功とも失敗とも扱わない。
      { checkName: "test", conclusion: null, summary: "" },
    ],
  });
  const { scanner, startInputs } = loop(ports, { checkFailures });

  await scanner.runOnce();

  expect(checkFailures.entries()).toEqual({
    [`${repositoryId}/${headRef}/typecheck`]: 0,
    [`${repositoryId}/${headRef}/test`]: 2,
  });
  expect(startInputs).toEqual([]);
});

test("a check already at the convergence limit no longer triggers a Job", async () => {
  const failing: PrResponseCheckStatus[] = [
    { checkName: "typecheck", conclusion: "failure", summary: "2 errors" },
  ];
  const belowLimit = loop(fakePorts({ checkStatuses: failing }).ports, {
    checkFailures: fakeCheckFailures({
      [`${repositoryId}/${headRef}/typecheck`]: prResponseCheckFailureLimit - 1,
    }),
  });

  expect(await belowLimit.scanner.runOnce()).toMatchObject({ jobsStarted: 1 });
  expect(belowLimit.startInputs[0]!.trigger).toEqual({
    kind: "check_failure",
    checkName: "typecheck",
    conclusion: "failure",
    summary: "2 errors",
  });

  // ADR 0007の収束上限に達したcheckは、以降のscanで対象から外れる。
  const atLimit = loop(fakePorts({ checkStatuses: failing }).ports, {
    checkFailures: fakeCheckFailures({
      [`${repositoryId}/${headRef}/typecheck`]: prResponseCheckFailureLimit,
    }),
  });

  expect(await atLimit.scanner.runOnce()).toEqual({
    candidatesConsidered: 1,
    jobsStarted: 0,
  });
  expect(atLimit.startInputs).toEqual([]);
});

test("a Pull Request already in flight is not started twice", async () => {
  let release = () => {};
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { ports } = fakePorts({ reviews: [humanReview] });
  const { scanner, startInputs } = loop(ports, {
    start: async () => ({
      status: "started",
      finished: running,
      close: () => {},
    }),
  });

  expect(await scanner.runOnce()).toMatchObject({ jobsStarted: 1 });
  // 走っている間は、同じtriggerを読み直しても二重に起動しない。
  expect(await scanner.runOnce()).toEqual({
    candidatesConsidered: 0,
    jobsStarted: 0,
  });
  expect(startInputs).toHaveLength(1);

  release();
  await running;
  // 終わったJobは登録から外れ、次のscanが同じPRを取り直せる。
  await Bun.sleep(0);
  expect(await scanner.runOnce()).toMatchObject({ jobsStarted: 1 });
  expect(startInputs).toHaveLength(2);
});

test("a refused start is logged and lets the next scan retry the same Pull Request", async () => {
  const { ports } = fakePorts({ reviews: [humanReview] });
  const { scanner, startInputs, logs } = loop(ports, {
    start: async () => ({
      status: "refused",
      reason: "branch_not_exclusive",
    }),
  });

  expect(await scanner.runOnce()).toEqual({
    candidatesConsidered: 1,
    jobsStarted: 0,
  });
  expect(logs).toEqual([
    {
      type: "job_start_refused",
      prNumber: 42,
      reason: "branch_not_exclusive",
    },
  ]);

  // 起動できなかったPRは押さえたままにせず、次のscanで再び対象になる。
  expect(await scanner.runOnce()).toMatchObject({ candidatesConsidered: 1 });
  expect(startInputs).toHaveLength(2);
});
