import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openServeLocalState } from "./local-state";
import {
  createPrResponseCheckFailureStore,
  prResponseCheckFailureLimit,
} from "./pr-response-check-failures";

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-pr-response-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));

  try {
    return await run(database);
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

test("increments per (repository, branch, check) and stops at the ADR 0007 limit", async () => {
  await withDatabase(async (database) => {
    const store = createPrResponseCheckFailureStore(database);

    expect(store.count(11, "oriel/x-gh-1-abc", "lint")).toBe(0);

    expect(store.increment(11, "oriel/x-gh-1-abc", "lint")).toBe(1);
    expect(store.increment(11, "oriel/x-gh-1-abc", "lint")).toBe(2);
    expect(store.increment(11, "oriel/x-gh-1-abc", "lint")).toBe(3);
    expect(store.count(11, "oriel/x-gh-1-abc", "lint")).toBe(
      prResponseCheckFailureLimit,
    );

    // 別のcheck、別のbranchは独立して数える。
    expect(store.count(11, "oriel/x-gh-1-abc", "typecheck")).toBe(0);
    expect(store.count(12, "oriel/x-gh-1-abc", "lint")).toBe(0);
  });
});

test("resets to zero once a check is observed resolved", async () => {
  await withDatabase(async (database) => {
    const store = createPrResponseCheckFailureStore(database);

    store.increment(11, "oriel/x-gh-1-abc", "lint");
    store.increment(11, "oriel/x-gh-1-abc", "lint");
    store.reset(11, "oriel/x-gh-1-abc", "lint");

    expect(store.count(11, "oriel/x-gh-1-abc", "lint")).toBe(0);
  });
});
