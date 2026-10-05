import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { GitHubRepository } from "@mikan-919/oriel-contracts";

import { openServeLocalState } from "./local-state";
import { createTranscriptStore } from "./transcript-store";

const repository: GitHubRepository = { owner: "mikan-919", name: "oriel" };
const otherRepository: GitHubRepository = { owner: "mikan-919", name: "other" };

async function withStore<T>(
  run: (store: ReturnType<typeof createTranscriptStore>) => T,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "oriel-transcript-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));

  try {
    return run(createTranscriptStore(database));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("assigns increasing per-job sequence numbers", async () => {
  await withStore((store) => {
    store.append({
      jobId: "job-1",
      repository,
      kind: "model.stream.event",
      content: "first",
    });
    store.append({
      jobId: "job-1",
      repository,
      kind: "model.stream.event",
      content: "second",
    });
    store.append({
      jobId: "job-2",
      repository,
      kind: "model.stream.event",
      content: "other job",
    });

    const entries = store.search({
      repository,
      scope: "local",
      query: "",
      limit: 10,
    });
    const forJob1 = entries
      .filter((entry) => entry.jobId === "job-1")
      .sort((a, b) => a.sequence - b.sequence);

    expect(forJob1.map((entry) => entry.sequence)).toEqual([1, 2]);
  });
});

test("finds a 3+ character query via FTS5 trigram regardless of position", async () => {
  await withStore((store) => {
    store.append({
      jobId: "job-1",
      repository,
      kind: "model.stream.event",
      content: "the quick brown fox jumps",
    });
    store.append({
      jobId: "job-2",
      repository,
      kind: "model.stream.event",
      content: "totally unrelated content",
    });

    const entries = store.search({
      repository,
      scope: "local",
      query: "brown fox",
      limit: 10,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.jobId).toBe("job-1");
  });
});

test("falls back to LIKE for queries shorter than 3 characters", async () => {
  await withStore((store) => {
    store.append({
      jobId: "job-1",
      repository,
      kind: "model.stream.event",
      content: "ab cd",
    });
    store.append({
      jobId: "job-2",
      repository,
      kind: "model.stream.event",
      content: "xy zz",
    });

    const entries = store.search({
      repository,
      scope: "local",
      query: "cd",
      limit: 10,
    });

    expect(entries.map((entry) => entry.jobId)).toEqual(["job-1"]);
  });
});

test("treats LIKE wildcard characters in a short query literally", async () => {
  await withStore((store) => {
    store.append({
      jobId: "job-1",
      repository,
      kind: "model.stream.event",
      content: "50% done",
    });
    store.append({
      jobId: "job-2",
      repository,
      kind: "model.stream.event",
      content: "50X done",
    });

    const entries = store.search({
      repository,
      scope: "local",
      query: "0%",
      limit: 10,
    });

    expect(entries.map((entry) => entry.jobId)).toEqual(["job-1"]);
  });
});

test("job scope only returns entries for the given job", async () => {
  await withStore((store) => {
    store.append({
      jobId: "job-1",
      repository,
      kind: "model.stream.event",
      content: "shared word",
    });
    store.append({
      jobId: "job-2",
      repository,
      kind: "model.stream.event",
      content: "shared word",
    });

    const entries = store.search({
      repository,
      scope: "job",
      jobId: "job-1",
      query: "shared",
      limit: 10,
    });

    expect(entries.map((entry) => entry.jobId)).toEqual(["job-1"]);
  });
});

test("job scope without a jobId returns nothing", async () => {
  await withStore((store) => {
    store.append({
      jobId: "job-1",
      repository,
      kind: "model.stream.event",
      content: "shared word",
    });

    expect(
      store.search({ repository, scope: "job", query: "shared", limit: 10 }),
    ).toEqual([]);
  });
});

test("does not cross repositories stored in the same database", async () => {
  await withStore((store) => {
    store.append({
      jobId: "job-1",
      repository,
      kind: "model.stream.event",
      content: "shared word",
    });
    store.append({
      jobId: "job-1",
      repository: otherRepository,
      kind: "model.stream.event",
      content: "shared word",
    });

    const entries = store.search({
      repository,
      scope: "local",
      query: "shared",
      limit: 10,
    });

    expect(entries).toHaveLength(1);
  });
});
