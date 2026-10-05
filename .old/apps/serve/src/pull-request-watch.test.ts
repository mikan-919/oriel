import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createPullRequestWatchStore } from "./pull-request-watch";
import { openServeLocalState } from "./local-state";

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-pr-watch-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));

  try {
    return await run(database);
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

const entry = {
  jobId: "implementation:11:28:abc",
  repositoryOwner: "mikan-919",
  repositoryName: "oriel",
  prNumber: 4,
  linearIssueId: "0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f",
  status: "watching" as const,
};

test("upserted entries appear in the watching list until marked done", async () => {
  await withDatabase(async (database) => {
    const store = createPullRequestWatchStore(database);

    store.upsert(entry);
    expect(store.watching()).toEqual([entry]);

    store.markDone(entry.jobId);
    expect(store.watching()).toEqual([]);
  });
});

test("re-upserting the same job replaces its record instead of duplicating it", async () => {
  await withDatabase(async (database) => {
    const store = createPullRequestWatchStore(database);

    store.upsert(entry);
    store.upsert({ ...entry, prNumber: 9 });

    expect(store.watching()).toEqual([{ ...entry, prNumber: 9 }]);
  });
});
