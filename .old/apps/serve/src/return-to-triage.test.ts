import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openServeLocalState } from "./local-state";
import {
  createReturnToTriageOutbox,
  returnApprovalToTriage,
  type LinearApprovalStatePorts,
} from "./return-to-triage";

const digest = "a".repeat(64);

const target = {
  jobId: `implementation:11:28:${digest}`,
  jobLeaseId: "job-lease-1",
  branchLeaseId: "branch-lease-1",
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
  linearIssueId: "0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f",
  approvalFingerprint: digest,
};

function ownership(current = true) {
  return { hasCurrentJobOwnership: () => current };
}

/** Linear stateの現在値を読み書きする境界。読み直しの結果も差し替えられる。 */
function fakeLinear(
  states: (string | null)[],
  moved = true,
): LinearApprovalStatePorts & { calls: string[] } {
  const calls: string[] = [];
  const queue = [...states];

  return {
    calls,
    async readLinearState() {
      calls.push("read");
      return queue.length > 1 ? (queue.shift() ?? null) : (queue[0] ?? null);
    },
    async moveToTriage() {
      calls.push("move");
      return moved;
    },
  };
}

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-return-to-triage-"));
  const database = openServeLocalState(join(directory, "serve.sqlite"));

  try {
    return await run(database);
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

test("an approval that no longer matches is moved back to Triage", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear(["Todo", "Triage"]);
    const outbox = createReturnToTriageOutbox(database);

    expect(
      await returnApprovalToTriage({
        database,
        ownership: ownership(),
        ports: linear,
        target,
        newAttemptId: () => "attempt-1",
      }),
    ).toBe("returned");

    // 現在値の確認、送信前の永続化、送信、読み直しの順。理由commentは投稿しない。
    expect(linear.calls).toEqual(["read", "move", "read"]);
    expect(outbox.find("attempt-1")).toEqual({
      attemptId: "attempt-1",
      jobId: target.jobId,
      jobLeaseId: target.jobLeaseId,
      linearIssueId: target.linearIssueId,
      operation: "return-to-triage",
      approvalFingerprint: digest,
      status: "returned",
    });
  });
});

test("a serve that no longer holds the Job ownership writes nothing", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear(["Todo", "Triage"]);

    expect(
      await returnApprovalToTriage({
        database,
        ownership: ownership(false),
        ports: linear,
        target,
        newAttemptId: () => "attempt-1",
      }),
    ).toBe("ownership_not_current");
    expect(linear.calls).toEqual([]);
    expect(createReturnToTriageOutbox(database).find("attempt-1")).toBeNull();
  });
});

test("an Issue that is already in Triage succeeds without sending an update", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear(["Triage"]);

    expect(
      await returnApprovalToTriage({
        database,
        ownership: ownership(),
        ports: linear,
        target,
        newAttemptId: () => "attempt-1",
      }),
    ).toBe("returned");
    expect(linear.calls).toEqual(["read"]);
  });
});

test("a state a human already changed is not overwritten", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear(["In Progress"]);

    expect(
      await returnApprovalToTriage({
        database,
        ownership: ownership(),
        ports: linear,
        target,
        newAttemptId: () => "attempt-1",
      }),
    ).toBe("externally_changed");
    expect(linear.calls).toEqual(["read"]);
  });
});

test("an Issue that stays Todo is recorded as unresolved and never resent", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear(["Todo", "Todo"], false);
    const outbox = createReturnToTriageOutbox(database);

    expect(
      await returnApprovalToTriage({
        database,
        ownership: ownership(),
        ports: linear,
        target,
        newAttemptId: () => "attempt-1",
      }),
    ).toBe("still_todo");
    // 送信は一度だけ。自動再送はしない。
    expect(linear.calls).toEqual(["read", "move", "read"]);
    expect(outbox.find("attempt-1")?.status).toBe("still_todo");
  });
});

test("a state that cannot be read after the update stays unresolved", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear(["Todo", null]);

    expect(
      await returnApprovalToTriage({
        database,
        ownership: ownership(),
        ports: linear,
        target,
        newAttemptId: () => "attempt-1",
      }),
    ).toBe("still_todo");
  });
});

test("a state that cannot be read at all sends nothing", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear([null]);

    expect(
      await returnApprovalToTriage({
        database,
        ownership: ownership(),
        ports: linear,
        target,
        newAttemptId: () => "attempt-1",
      }),
    ).toBe("state_unknown");
    expect(linear.calls).toEqual(["read"]);
  });
});

test("a human retry reuses neither the attempt ID nor a stale ownership", async () => {
  await withDatabase(async (database) => {
    const outbox = createReturnToTriageOutbox(database);

    expect(
      await returnApprovalToTriage({
        database,
        ownership: ownership(),
        ports: fakeLinear(["Todo", "Todo"], false),
        target,
        newAttemptId: () => "attempt-1",
      }),
    ).toBe("still_todo");
    expect(
      await returnApprovalToTriage({
        database,
        ownership: ownership(),
        ports: fakeLinear(["Todo", "Triage"]),
        target,
        newAttemptId: () => "attempt-2",
      }),
    ).toBe("returned");

    expect(outbox.find("attempt-1")?.status).toBe("still_todo");
    expect(outbox.find("attempt-2")?.status).toBe("returned");
  });
});
