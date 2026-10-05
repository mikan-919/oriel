import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import type { ApprovalReconciliation } from "./implementation-admission";
import {
  moveApprovalToInProgress,
  type LinearInProgressPorts,
  type MoveToInProgressStatus,
} from "./linear-progress";
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

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-linear-progress-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));

  try {
    return await run(database);
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

/** Linear stateの現在値と、送信したattemptを記録するfake。 */
function fakeLinear({
  stateName = "Todo" as string | null,
  movable = true,
} = {}) {
  const moves: string[] = [];
  let current = stateName;

  return {
    moves,
    state: () => current,
    ports: {
      readLinearState: async () => current,
      moveToInProgress: async (issueId: string) => {
        moves.push(issueId);

        if (!movable) {
          return false;
        }

        current = "In Progress";

        return true;
      },
    } satisfies LinearInProgressPorts,
  };
}

function attempts(database: Database) {
  return database
    .query(
      `SELECT operation, linear_issue_id AS linearIssueId, job_lease_id AS jobLeaseId, status
       FROM linear_progress_outbox`,
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
): Promise<MoveToInProgressStatus> {
  return moveApprovalToInProgress({
    database,
    ownership: {
      hasCurrentJobOwnership: () => options.owned ?? true,
    },
    ports: (options.linear ?? fakeLinear()).ports,
    reconcileApproval: async () =>
      options.approval ?? { status: "current", approvalFingerprint: digest },
    target,
  });
}

test("the worker start moves the approved Linear issue from Todo to In Progress", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear();

    expect(await move(database, { linear })).toBe("in_progress");
    expect(linear.moves).toEqual([linearIssueId]);
    expect(linear.state()).toBe("In Progress");

    // 送信前の試行が、用途を限った操作記録として永続化されている。
    expect(attempts(database)).toEqual([
      {
        operation: "move-to-in-progress",
        linearIssueId,
        jobLeaseId: target.jobLeaseId,
        status: "in_progress",
      },
    ]);
  });
});

test("only a serve that still holds the ownership and the approval writes the state", async () => {
  await withDatabase(async (database) => {
    const withoutOwnership = fakeLinear();

    expect(
      await move(database, { linear: withoutOwnership, owned: false }),
    ).toBe("ownership_not_current");

    // 承認対象が変わっていれば反映せず、差し戻し経路へ委ねる。
    const changed = fakeLinear();

    expect(
      await move(database, {
        linear: changed,
        approval: { status: "changed" },
      }),
    ).toBe("approval_changed");

    // 読めなかっただけの提供元障害でも書かない。
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

test("a Linear issue that is no longer Todo is not overwritten", async () => {
  await withDatabase(async (database) => {
    // 人間または他処理が別のstateへ変えていた場合。
    const done = fakeLinear({ stateName: "Done" });

    expect(await move(database, { linear: done })).toBe("externally_changed");
    expect(done.moves).toEqual([]);

    // すでにIn Progressなら、同じ意図として成功に収束する。
    const already = fakeLinear({ stateName: "In Progress" });

    expect(await move(database, { linear: already })).toBe("in_progress");
    expect(already.moves).toEqual([]);

    // 現在stateを読めない場合は送信もしない。
    const unreadable = fakeLinear({ stateName: null });

    expect(await move(database, { linear: unreadable })).toBe("state_unknown");
    expect(unreadable.moves).toEqual([]);
    expect(attempts(database)).toEqual([]);
  });
});

test("an unknown result is reconciled by rereading, never by a blind resend", async () => {
  await withDatabase(async (database) => {
    const stuck = fakeLinear({ movable: false });

    expect(await move(database, { linear: stuck })).toBe("still_todo");
    // 現在値がTodoのままである場合だけ、同じdesired stateをもう一度送る。
    expect(stuck.moves).toEqual([linearIssueId, linearIssueId]);
    expect(
      attempts(database).map(
        (attempt) => (attempt as { status: string }).status,
      ),
    ).toEqual(["still_todo", "still_todo"]);
  });
});
