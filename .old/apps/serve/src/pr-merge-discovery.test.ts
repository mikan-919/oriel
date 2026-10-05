import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  createPrMergeDiscoveryLoop,
  type PrMergePorts,
} from "./pr-merge-discovery";
import { createPullRequestWatchStore } from "./pull-request-watch";
import { openServeLocalState } from "./local-state";

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-pr-merge-"));
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

function fakePorts({
  merged = false,
  stateName = "In Review" as string | null,
}: { merged?: boolean; stateName?: string | null } = {}): {
  ports: PrMergePorts;
  moves: string[];
} {
  const moves: string[] = [];
  let current = stateName;

  return {
    moves,
    ports: {
      isPullRequestMerged: async () => merged,
      readLinearState: async () => current,
      moveToDone: async (issueId) => {
        moves.push(issueId);
        current = "Done";

        return true;
      },
    },
  };
}

test("reflects Done and stops watching once a tracked pull request is merged", async () => {
  await withDatabase(async (database) => {
    const watchStore = createPullRequestWatchStore(database);

    watchStore.upsert(entry);

    const { ports, moves } = fakePorts({ merged: true });
    const loop = createPrMergeDiscoveryLoop({
      createPorts: async () => ports,
      database,
      watchStore,
      pollIntervalMs: 60_000,
    });

    expect(await loop.runOnce()).toEqual({ checked: 1, reflected: 1 });
    expect(moves).toEqual([entry.linearIssueId]);
    expect(watchStore.watching()).toEqual([]);
  });
});

test("keeps watching while the pull request is still open", async () => {
  await withDatabase(async (database) => {
    const watchStore = createPullRequestWatchStore(database);

    watchStore.upsert(entry);

    const { ports, moves } = fakePorts({ merged: false });
    const loop = createPrMergeDiscoveryLoop({
      createPorts: async () => ports,
      database,
      watchStore,
      pollIntervalMs: 60_000,
    });

    expect(await loop.runOnce()).toEqual({ checked: 1, reflected: 0 });
    expect(moves).toEqual([]);
    expect(watchStore.watching()).toEqual([entry]);
  });
});

test("a scan with no usable credentials touches nothing", async () => {
  await withDatabase(async (database) => {
    const watchStore = createPullRequestWatchStore(database);

    watchStore.upsert(entry);

    const loop = createPrMergeDiscoveryLoop({
      createPorts: async () => null,
      database,
      watchStore,
      pollIntervalMs: 60_000,
    });

    expect(await loop.runOnce()).toEqual({ checked: 0, reflected: 0 });
    expect(watchStore.watching()).toEqual([entry]);
  });
});
