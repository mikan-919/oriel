import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { IssueBodyUpdateRequest } from "@mikan-919/oriel-contracts";

import {
  GitHubIssueBodyRejectedError,
  updateIssueBody,
  type GitHubIssueBodyPublisher,
} from "./issue-body";
import { openServeLocalState } from "./local-state";

const request: IssueBodyUpdateRequest = {
  type: "issue_body.request",
  requestId: "req-1",
  jobId: "what-confirmation:11:28:comment-1",
  jobLeaseId: "lease-1",
  repository: { owner: "acme", name: "widgets" },
  issueNumber: 28,
  body: "The dashboard should load in under 2s.",
};

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-issue-body-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));

  try {
    return await run(database);
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function fakePublisher(currentBody: () => string | null): {
  publisher: GitHubIssueBodyPublisher;
  updated: string[];
} {
  const updated: string[] = [];
  let stored = currentBody();

  return {
    updated,
    publisher: {
      async updateIssueBody({ body }) {
        updated.push(body);
        stored = body;
      },
      async readIssueBody() {
        return stored;
      },
    },
  };
}

test("updates the body and confirms it by reading it back", async () => {
  await withDatabase(async (database) => {
    const { publisher, updated } = fakePublisher(() => "old body");

    const event = await updateIssueBody({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      publisher,
      request,
    });

    expect(event).toEqual({ type: "issue_body.completed", requestId: "req-1" });
    expect(updated).toEqual([request.body]);
  });
});

test("refuses without writing when ownership is not current", async () => {
  await withDatabase(async (database) => {
    const { publisher, updated } = fakePublisher(() => "old body");

    const event = await updateIssueBody({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => false },
      publisher,
      request,
    });

    expect(event).toEqual({
      type: "issue_body.rejected",
      requestId: "req-1",
      reason: "ownership_not_current",
    });
    expect(updated).toEqual([]);
  });
});

test("reports github_rejected when the publisher throws", async () => {
  await withDatabase(async (database) => {
    const publisher: GitHubIssueBodyPublisher = {
      async updateIssueBody() {
        throw new GitHubIssueBodyRejectedError("forbidden");
      },
      async readIssueBody() {
        return null;
      },
    };

    const event = await updateIssueBody({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      publisher,
      request,
    });

    expect(event).toEqual({
      type: "issue_body.rejected",
      requestId: "req-1",
      reason: "github_rejected",
    });
  });
});

test("reports github_rejected when the read-after-write body does not match", async () => {
  await withDatabase(async (database) => {
    const publisher: GitHubIssueBodyPublisher = {
      async updateIssueBody() {},
      async readIssueBody() {
        return "a different body entirely";
      },
    };

    const event = await updateIssueBody({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      publisher,
      request,
    });

    expect(event).toEqual({
      type: "issue_body.rejected",
      requestId: "req-1",
      reason: "github_rejected",
    });
  });
});
