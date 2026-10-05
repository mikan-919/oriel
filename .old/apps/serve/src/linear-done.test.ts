import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { reflectDoneState, type LinearDonePorts } from "./linear-done";
import { openServeLocalState } from "./local-state";

const jobId = "implementation:11:28:done";
const linearIssueId = "0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f";

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-linear-done-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));

  try {
    return await run(database);
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function fakeLinear({
  stateName = "In Review" as string | null,
  movable = true,
} = {}) {
  const moves: string[] = [];
  let current = stateName;

  return {
    moves,
    state: () => current,
    ports: {
      readLinearState: async () => current,
      moveToDone: async (issueId: string) => {
        moves.push(issueId);

        if (!movable) {
          return false;
        }

        current = "Done";

        return true;
      },
    } satisfies LinearDonePorts,
  };
}

function attempts(database: Database) {
  return database
    .query(
      `SELECT operation, linear_issue_id AS linearIssueId, status
       FROM linear_done_outbox`,
    )
    .all();
}

test("moves a merged Workflow's Linear issue to Done regardless of its current state", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear();

    expect(
      await reflectDoneState({
        database,
        ports: linear.ports,
        target: { jobId, linearIssueId },
      }),
    ).toBe("done");
    expect(linear.moves).toEqual([linearIssueId]);
    expect(attempts(database)).toEqual([
      { operation: "move-to-done", linearIssueId, status: "done" },
    ]);
  });
});

test("an already-Done issue is a no-op", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear({ stateName: "Done" });

    expect(
      await reflectDoneState({
        database,
        ports: linear.ports,
        target: { jobId, linearIssueId },
      }),
    ).toBe("done");
    expect(linear.moves).toEqual([]);
    expect(attempts(database)).toEqual([]);
  });
});

test("an unreadable current state refuses without writing", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear({ stateName: null });

    expect(
      await reflectDoneState({
        database,
        ports: linear.ports,
        target: { jobId, linearIssueId },
      }),
    ).toBe("state_unknown");
    expect(linear.moves).toEqual([]);
    expect(attempts(database)).toEqual([]);
  });
});

test("a failed or unconfirmed move is reported rather than resent", async () => {
  await withDatabase(async (database) => {
    const linear = fakeLinear({ movable: false });

    expect(
      await reflectDoneState({
        database,
        ports: linear.ports,
        target: { jobId, linearIssueId },
      }),
    ).toBe("still_open");
    expect(linear.moves).toEqual([linearIssueId]);
    expect(attempts(database)).toEqual([
      { operation: "move-to-done", linearIssueId, status: "still_open" },
    ]);
  });
});
