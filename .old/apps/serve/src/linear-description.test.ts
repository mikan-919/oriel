import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { LinearDescriptionUpdateRequest } from "@mikan-919/oriel-contracts";

import { openServeLocalState } from "./local-state";
import {
  updateLinearDescription,
  type LinearDescriptionPublisher,
} from "./linear-description";

const request: LinearDescriptionUpdateRequest = {
  type: "linear_description.request",
  requestId: "req-1",
  jobId: "linear-conversation:11:34:abc",
  jobLeaseId: "lease-1",
  repository: { owner: "acme", name: "widgets" },
  issueNumber: 34,
  linearIssueId: "lin-1",
  description: "Confirmed HOW: implement via X.",
  baselineDescription: "old description",
};

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-linear-description-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));

  try {
    return await run(database);
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function fakePublisher(currentDescription: () => string | null): {
  publisher: LinearDescriptionPublisher;
  updated: string[];
} {
  const updated: string[] = [];
  let stored = currentDescription();

  return {
    updated,
    publisher: {
      async updateDescription({ description }) {
        updated.push(description);
        stored = description;
      },
      async readDescription() {
        return stored;
      },
    },
  };
}

test("updates the description and confirms it by reading it back", async () => {
  await withDatabase(async (database) => {
    const { publisher, updated } = fakePublisher(() => "old description");

    const event = await updateLinearDescription({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      publisher,
      request,
    });

    expect(event).toEqual({
      type: "linear_description.completed",
      requestId: "req-1",
    });
    expect(updated).toEqual([request.description]);
  });
});

test("refuses without writing when ownership is not current", async () => {
  await withDatabase(async (database) => {
    const { publisher, updated } = fakePublisher(() => "old description");

    const event = await updateLinearDescription({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => false },
      publisher,
      request,
    });

    expect(event).toEqual({
      type: "linear_description.rejected",
      requestId: "req-1",
      reason: "ownership_not_current",
    });
    expect(updated).toEqual([]);
  });
});

test("rejects with concurrent_change instead of merging when a human edited it first", async () => {
  await withDatabase(async (database) => {
    const { publisher, updated } = fakePublisher(
      () => "a human already changed this",
    );

    const event = await updateLinearDescription({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      publisher,
      request,
    });

    expect(event).toEqual({
      type: "linear_description.rejected",
      requestId: "req-1",
      reason: "concurrent_change",
    });
    // 拒否時は一切書き込まない。汎用mergeで上書きしない。
    expect(updated).toEqual([]);
  });
});

test("reports linear_rejected when the current description cannot be read", async () => {
  await withDatabase(async (database) => {
    const publisher: LinearDescriptionPublisher = {
      async updateDescription() {},
      async readDescription() {
        return null;
      },
    };

    const event = await updateLinearDescription({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      publisher,
      request,
    });

    expect(event).toEqual({
      type: "linear_description.rejected",
      requestId: "req-1",
      reason: "linear_rejected",
    });
  });
});

test("reports linear_rejected when the publisher throws", async () => {
  await withDatabase(async (database) => {
    let reads = 0;
    const publisher: LinearDescriptionPublisher = {
      async updateDescription() {
        throw new Error("forbidden");
      },
      async readDescription() {
        reads += 1;
        return reads === 1 ? request.baselineDescription : "old description";
      },
    };

    const event = await updateLinearDescription({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      publisher,
      request,
    });

    expect(event).toEqual({
      type: "linear_description.rejected",
      requestId: "req-1",
      reason: "linear_rejected",
    });
  });
});

test("reports linear_rejected when the read-after-write description does not match", async () => {
  await withDatabase(async (database) => {
    let reads = 0;
    const publisher: LinearDescriptionPublisher = {
      async updateDescription() {},
      async readDescription() {
        reads += 1;
        return reads === 1
          ? request.baselineDescription
          : "a different description entirely";
      },
    };

    const event = await updateLinearDescription({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      publisher,
      request,
    });

    expect(event).toEqual({
      type: "linear_description.rejected",
      requestId: "req-1",
      reason: "linear_rejected",
    });
  });
});
