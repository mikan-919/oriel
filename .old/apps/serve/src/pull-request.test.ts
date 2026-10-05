import { expect, test } from "bun:test";

import type { ApprovalReconciliation } from "./implementation-admission";
import type { JobOwnershipVerifier } from "./issue-comments";
import { ensurePullRequest, type PullRequestPorts } from "./pull-request";

const digest = "a".repeat(64);
const target = {
  jobId: `implementation:11:28:${digest}`,
  jobLeaseId: "job-lease-1",
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
  approvalFingerprint: digest,
  head: `oriel/ENG-12-gh-28-${digest}`,
  base: "main",
  title: "WHAT title",
  body: "Closes #28",
};

function ownership(owned = true): JobOwnershipVerifier {
  return { hasCurrentJobOwnership: async () => owned };
}

function reconcile(
  status: ApprovalReconciliation = {
    status: "current",
    approvalFingerprint: digest,
  },
) {
  return async () => status;
}

function fakePorts(overrides: Partial<PullRequestPorts> = {}): {
  ports: PullRequestPorts;
  closed: { number: number; canonicalNumber: number }[];
} {
  const closed: { number: number; canonicalNumber: number }[] = [];

  return {
    closed,
    ports: {
      listOpenPullRequestsByHeadBase: async () => [],
      createPullRequest: async () => ({ number: 1 }),
      closeDuplicatePullRequest: async (input) => {
        closed.push(input);

        return true;
      },
      ...overrides,
    },
  };
}

test("creates a pull request when no candidate exists", async () => {
  const { ports } = fakePorts();

  expect(
    await ensurePullRequest({
      ownership: ownership(),
      ports,
      reconcileApproval: reconcile(),
      target,
    }),
  ).toEqual({ status: "created", number: 1 });
});

test("adopts the sole existing candidate instead of creating a duplicate", async () => {
  const { ports, closed } = fakePorts({
    listOpenPullRequestsByHeadBase: async () => [{ number: 5 }],
  });

  expect(
    await ensurePullRequest({
      ownership: ownership(),
      ports,
      reconcileApproval: reconcile(),
      target,
    }),
  ).toEqual({ status: "adopted", number: 5 });
  expect(closed).toEqual([]);
});

test("keeps the lowest-numbered candidate and closes the rest", async () => {
  const { ports, closed } = fakePorts({
    listOpenPullRequestsByHeadBase: async () => [
      { number: 9 },
      { number: 4 },
      { number: 6 },
    ],
  });

  expect(
    await ensurePullRequest({
      ownership: ownership(),
      ports,
      reconcileApproval: reconcile(),
      target,
    }),
  ).toEqual({ status: "adopted", number: 4 });
  expect(closed).toEqual([
    { number: 6, canonicalNumber: 4 },
    { number: 9, canonicalNumber: 4 },
  ]);
});

test("recovers from a create race by relisting and adopting", async () => {
  let listed = 0;
  const { ports } = fakePorts({
    listOpenPullRequestsByHeadBase: async () => {
      listed += 1;

      return listed === 1 ? [] : [{ number: 11 }];
    },
    createPullRequest: async () => "already_exists",
  });

  expect(
    await ensurePullRequest({
      ownership: ownership(),
      ports,
      reconcileApproval: reconcile(),
      target,
    }),
  ).toEqual({ status: "adopted", number: 11 });
});

test("refuses without touching GitHub when ownership is not current", async () => {
  const { ports } = fakePorts({
    listOpenPullRequestsByHeadBase: async () => {
      throw new Error("must not be called");
    },
  });

  expect(
    await ensurePullRequest({
      ownership: ownership(false),
      ports,
      reconcileApproval: reconcile(),
      target,
    }),
  ).toEqual({ status: "ownership_not_current", number: null });
});

test("refuses when the approval changed", async () => {
  const { ports } = fakePorts();

  expect(
    await ensurePullRequest({
      ownership: ownership(),
      ports,
      reconcileApproval: reconcile({ status: "changed" }),
      target,
    }),
  ).toEqual({ status: "approval_changed", number: null });
});

test("refuses when the approval cannot be read", async () => {
  const { ports } = fakePorts();

  expect(
    await ensurePullRequest({
      ownership: ownership(),
      ports,
      reconcileApproval: reconcile({ status: "unknown" }),
      target,
    }),
  ).toEqual({ status: "approval_state_unknown", number: null });
});

test("refuses when the candidate list cannot be read", async () => {
  const { ports } = fakePorts({
    listOpenPullRequestsByHeadBase: async () => null,
  });

  expect(
    await ensurePullRequest({
      ownership: ownership(),
      ports,
      reconcileApproval: reconcile(),
      target,
    }),
  ).toEqual({ status: "pull_request_state_unknown", number: null });
});

test("refuses when creation fails outright", async () => {
  const { ports } = fakePorts({ createPullRequest: async () => null });

  expect(
    await ensurePullRequest({
      ownership: ownership(),
      ports,
      reconcileApproval: reconcile(),
      target,
    }),
  ).toEqual({ status: "pull_request_create_failed", number: null });
});
