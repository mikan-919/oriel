import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import type { ApprovalReconciliation } from "./implementation-admission";
import {
  reflectReviewState,
  type LinearReviewStatePorts,
  type ReflectReviewStateStatus,
} from "./linear-review-state";
import type { ReviewStateCandidate } from "./linear-approval";
import { openServeLocalState } from "./local-state";

const digest = "a".repeat(64);
const linearIssueId = "0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f";
const target = {
  jobId: `implementation:11:28:${digest}`,
  jobLeaseId: "job-lease-1",
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
  linearIssueId,
  approvalFingerprint: digest,
};
const review = { id: "state-review", name: "In Review" };

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-linear-review-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));

  try {
    return await run(database);
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function fakeLinear({
  stateName = "In Progress" as string | null,
  candidate = review as ReviewStateCandidate | null,
  movable = true,
} = {}) {
  const moves: string[] = [];
  let current = stateName;

  return {
    moves,
    state: () => current,
    ports: {
      readLinearState: async () => current,
      readReviewStateCandidate: async () => candidate,
      moveToStateId: async (issueId: string, stateId: string) => {
        moves.push(`${issueId}:${stateId}`);

        if (!movable) {
          return false;
        }

        current = review.name;

        return true;
      },
    } satisfies LinearReviewStatePorts,
  };
}

function attempts(database: Database) {
  return database
    .query(
      `SELECT operation, linear_issue_id AS linearIssueId, status
       FROM linear_review_outbox`,
    )
    .all();
}

async function move(
  database: Database,
  options: {
    linear?: ReturnType<typeof fakeLinear>;
    owned?: boolean;
    approval?: ApprovalReconciliation;
  } = {},
): Promise<ReflectReviewStateStatus> {
  return reflectReviewState({
    database,
    ownership: { hasCurrentJobOwnership: () => options.owned ?? true },
    ports: (options.linear ?? fakeLinear()).ports,
    reconcileApproval: async () =>
      options.approval ?? { status: "current", approvalFingerprint: digest },
    target,
  });
}

test("moves from In Progress to the sole review-shaped state", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear();

    expect(await move(database, { linear })).toBe("in_review");
    expect(linear.moves).toEqual([`${linearIssueId}:${review.id}`]);
    expect(attempts(database)).toEqual([
      {
        operation: "move-to-review",
        linearIssueId,
        status: "in_review",
      },
    ]);
  });
});

test("keeps In Progress when no unique review state exists", async () => {
  await withDatabase(async (database) => {
    const none = fakeLinear({ candidate: "none" });

    expect(await move(database, { linear: none })).toBe("kept_in_progress");
    expect(none.moves).toEqual([]);

    const ambiguous = fakeLinear({ candidate: "ambiguous" });

    expect(await move(database, { linear: ambiguous })).toBe(
      "kept_in_progress",
    );
    expect(ambiguous.moves).toEqual([]);
    expect(attempts(database)).toEqual([]);
  });
});

test("only a serve that still holds ownership and the approval writes the state", async () => {
  await withDatabase(async (database) => {
    const withoutOwnership = fakeLinear();

    expect(
      await move(database, { linear: withoutOwnership, owned: false }),
    ).toBe("ownership_not_current");

    const changed = fakeLinear();

    expect(
      await move(database, {
        linear: changed,
        approval: { status: "changed" },
      }),
    ).toBe("approval_changed");

    const unknown = fakeLinear();

    expect(
      await move(database, {
        linear: unknown,
        approval: { status: "unknown" },
      }),
    ).toBe("approval_state_unknown");

    expect([
      ...withoutOwnership.moves,
      ...changed.moves,
      ...unknown.moves,
    ]).toEqual([]);
    expect(attempts(database)).toEqual([]);
  });
});

test("a Linear issue that already moved elsewhere is not overwritten", async () => {
  await withDatabase(async (database) => {
    const done = fakeLinear({ stateName: "Done" });

    expect(await move(database, { linear: done })).toBe("externally_changed");
    expect(done.moves).toEqual([]);

    const already = fakeLinear({ stateName: review.name });

    expect(await move(database, { linear: already })).toBe("in_review");
    expect(already.moves).toEqual([]);

    const unreadable = fakeLinear({ stateName: null });

    expect(await move(database, { linear: unreadable })).toBe("state_unknown");
    expect(unreadable.moves).toEqual([]);
  });
});

test("an unknown result is reconciled by rereading, never by a blind resend", async () => {
  await withDatabase(async (database) => {
    const stuck = fakeLinear({ movable: false });

    expect(await move(database, { linear: stuck })).toBe("still_in_progress");
    expect(stuck.moves).toEqual([
      `${linearIssueId}:${review.id}`,
      `${linearIssueId}:${review.id}`,
    ]);
  });
});
