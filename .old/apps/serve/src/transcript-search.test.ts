import { expect, test } from "bun:test";

import type {
  GitHubRepository,
  TranscriptEntry,
} from "@mikan-919/oriel-contracts";

import { createTranscriptSearch } from "./transcript-search";
import type { TranscriptStore } from "./transcript-store";

const repository: GitHubRepository = { owner: "mikan-919", name: "oriel" };

function fakeStore(entries: TranscriptEntry[]): TranscriptStore {
  return {
    append: () => {
      throw new Error("not used by this test");
    },
    search: () => entries,
  };
}

test("job and local scope never ask the relay to fan out", async () => {
  const local: TranscriptEntry[] = [
    {
      jobId: "job-1",
      sequence: 1,
      kind: "model.stream.event",
      content: "hi",
      createdAt: 1,
    },
  ];
  let calledRelay = false;
  const search = createTranscriptSearch(
    fakeStore(local),
    {
      searchRepository: async () => {
        calledRelay = true;
        return [];
      },
    },
    repository,
  );

  expect(await search({ scope: "local", query: "hi", limit: 10 })).toEqual(
    local,
  );
  expect(
    await search({ scope: "job", jobId: "job-1", query: "hi", limit: 10 }),
  ).toEqual(local);
  expect(calledRelay).toBe(false);
});

test("repository scope merges the local store with the relay-mediated siblings", async () => {
  const local: TranscriptEntry[] = [
    {
      jobId: "job-1",
      sequence: 1,
      kind: "model.stream.event",
      content: "hi",
      createdAt: 1,
    },
  ];
  const remote: TranscriptEntry[] = [
    {
      jobId: "job-2",
      sequence: 1,
      kind: "model.stream.event",
      content: "hi",
      createdAt: 2,
    },
  ];
  const search = createTranscriptSearch(
    fakeStore(local),
    { searchRepository: async () => remote },
    repository,
  );

  expect(await search({ scope: "repository", query: "hi", limit: 10 })).toEqual(
    [...local, ...remote],
  );
});

test("repository scope truncates the merged results to the requested limit", async () => {
  const local: TranscriptEntry[] = [
    {
      jobId: "job-1",
      sequence: 1,
      kind: "model.stream.event",
      content: "a",
      createdAt: 1,
    },
    {
      jobId: "job-1",
      sequence: 2,
      kind: "model.stream.event",
      content: "b",
      createdAt: 2,
    },
  ];
  const remote: TranscriptEntry[] = [
    {
      jobId: "job-2",
      sequence: 1,
      kind: "model.stream.event",
      content: "c",
      createdAt: 3,
    },
  ];
  const search = createTranscriptSearch(
    fakeStore(local),
    { searchRepository: async () => remote },
    repository,
  );

  const results = await search({ scope: "repository", query: "x", limit: 2 });

  expect(results).toEqual(local);
});
