import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";

import {
  createIssueCommentOutbox,
  createIssueCommentService,
  createOctokitIssueCommentPublisher,
  GitHubIssueCommentRejectedError,
  type GitHubIssueCommentPublisher,
} from "./issue-comments";
import { openServeLocalState } from "./local-state";

const request = {
  type: "issue_comment.request" as const,
  requestId: "request-1",
  jobId: "issue-conversation-1",
  jobLeaseId: "lease-1",
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
  body: "Agent reply",
};

test("accepts an owned Issue-comment request and persists the outbox operation before GitHub responds", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const result = Promise.withResolvers<{ id: number }>();
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({ createIssueComment: () => result.promise }),
    newOperationId: () => "operation-1",
  });

  const accepted = await service.accept(request);

  expect(accepted).toEqual({
    type: "issue_comment.accepted",
    requestId: "request-1",
    operationId: "operation-1",
  });
  expect(outbox.find("operation-1")).toMatchObject({
    operationId: "operation-1",
    requestId: "request-1",
    status: "pending",
    githubActorLogin: "oriel-bot",
  });

  result.resolve({ id: 1234 });
  await service.waitForOutcome("operation-1");
  database.close();
});

test("uses WAL and applies the SQL migration before persisting the outbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriel-issue-comment-"));
  const databasePath = join(directory, "serve.sqlite");

  try {
    const firstDatabase = openServeLocalState(databasePath);
    const firstOutbox = createIssueCommentOutbox(firstDatabase);
    firstOutbox.enqueue({
      ...request,
      operationId: "operation-1",
      githubActorLogin: "oriel-bot",
      bodyDigest: null,
      status: "pending",
      githubCommentId: null,
    });

    expect(firstDatabase.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    firstDatabase.close();

    const restartedDatabase = openServeLocalState(databasePath);
    const restartedOutbox = createIssueCommentOutbox(restartedDatabase);

    expect(restartedOutbox.find("operation-1")).toMatchObject({
      operationId: "operation-1",
      status: "pending",
    });
    restartedDatabase.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("upgrades an existing outbox database to actor and body-digest reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriel-issue-comment-"));
  const databasePath = join(directory, "serve.sqlite");
  const oldMigrationsFolder = join(directory, "old-migrations");

  try {
    await mkdir(join(oldMigrationsFolder, "meta"), { recursive: true });
    await writeFile(
      join(oldMigrationsFolder, "0000_issue_comment_outbox.sql"),
      `CREATE TABLE issue_comment_outbox (
        operation_id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        job_lease_id TEXT NOT NULL,
        repository_owner TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        body TEXT NOT NULL,
        baseline_comment_ids_json TEXT,
        status TEXT NOT NULL,
        github_comment_id INTEGER,
        UNIQUE(job_id, request_id)
      );\n`,
    );
    await writeFile(
      join(oldMigrationsFolder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 1786618800000,
            tag: "0000_issue_comment_outbox",
            breakpoints: true,
          },
        ],
      }),
    );
    const oldDatabase = openServeLocalState(databasePath, oldMigrationsFolder);
    oldDatabase.close();

    const database = openServeLocalState(databasePath);
    const columns = database
      .query("PRAGMA table_info(issue_comment_outbox)")
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toContain(
      "github_actor_login",
    );
    expect(columns.map((column) => column.name)).toContain("body_digest");
    expect(columns.map((column) => column.name)).not.toContain(
      "baseline_comment_ids_json",
    );
    database.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("finds each outbox operation by its own operation ID", () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);

  outbox.enqueue({
    ...request,
    operationId: "operation-1",
    githubActorLogin: "oriel-bot",
    bodyDigest: "digest-1",
    status: "pending",
    githubCommentId: null,
  });
  outbox.enqueue({
    ...request,
    requestId: "request-2",
    operationId: "operation-2",
    githubActorLogin: "oriel-bot",
    bodyDigest: "digest-2",
    status: "pending",
    githubCommentId: null,
  });

  expect(outbox.find("operation-1")?.requestId).toBe("request-1");
  expect(outbox.find("operation-2")?.requestId).toBe("request-2");
  database.close();
});

test("refuses an Issue-comment request when current Job ownership is absent", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => false },
    publisher: publisher(),
    newOperationId: () => "operation-1",
  });

  expect(await service.accept(request)).toEqual({
    type: "issue_comment.rejected",
    requestId: "request-1",
    reason: "ownership_not_current",
  });
  expect(outbox.find("operation-1")).toBeNull();
  database.close();
});

test("does not resume a persisted operation when it no longer owns that Job", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  outbox.enqueue({
    ...request,
    operationId: "operation-1",
    githubActorLogin: "oriel-bot",
    bodyDigest: "digest-1",
    status: "pending",
    githubCommentId: null,
  });
  let GitHubReadAttempted = false;
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => false },
    publisher: publisher({
      listIssueComments: async () => {
        GitHubReadAttempted = true;
        return [];
      },
    }),
  });

  await service.resumePending();

  expect(GitHubReadAttempted).toBe(false);
  expect(outbox.find("operation-1")?.status).toBe("pending");
  database.close();
});

test("resumes only the pending operation bound to this explicit Issue conversation", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  outbox.enqueue({
    ...request,
    operationId: "operation-a",
    githubActorLogin: "oriel-bot",
    bodyDigest: null,
    status: "pending",
    githubCommentId: null,
  });
  outbox.enqueue({
    ...request,
    requestId: "request-b",
    jobId: "issue-conversation-2",
    jobLeaseId: "lease-2",
    operationId: "operation-b",
    githubActorLogin: "oriel-bot",
    bodyDigest: null,
    status: "pending",
    githubCommentId: null,
  });
  const resumedOperationIds: string[] = [];
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createIssueComment: async ({ body }) => {
        resumedOperationIds.push(
          body.includes("operation-b") ? "operation-b" : "operation-a",
        );
        return { id: 1234 };
      },
    }),
  });

  service.resumePending({
    jobId: "issue-conversation-2",
    jobLeaseId: "lease-2",
    repository: request.repository,
    issueNumber: 28,
  });

  await service.waitForOutcome("operation-b");
  expect(resumedOperationIds).toEqual(["operation-b"]);
  expect(outbox.find("operation-a")?.status).toBe("pending");
  database.close();
});

test("fences GitHub writes with a fresh ownership confirmation", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const ownershipChecks: number[] = [];
  let publicationAttempted = false;
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: {
      hasCurrentJobOwnership: () => {
        ownershipChecks.push(ownershipChecks.length);
        return ownershipChecks.length === 1;
      },
    },
    publisher: publisher({
      createIssueComment: async () => {
        publicationAttempted = true;
        return { id: 1234 };
      },
    }),
    newOperationId: () => "operation-1",
  });

  expect((await service.accept(request)).type).toBe("issue_comment.accepted");
  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "issue_comment.rejected",
    requestId: "request-1",
    operationId: "operation-1",
    reason: "ownership_not_current",
  });
  expect(ownershipChecks).toHaveLength(2);
  expect(publicationAttempted).toBe(false);
  database.close();
});

test("notifies the harness with the completed GitHub Issue-comment event", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const published: Parameters<
    GitHubIssueCommentPublisher["createIssueComment"]
  >[0][] = [];
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createIssueComment: async (input) => {
        published.push(input);
        return { id: 1234 };
      },
    }),
    newOperationId: () => "operation-1",
  });

  expect(await service.accept(request)).toEqual({
    type: "issue_comment.accepted",
    requestId: "request-1",
    operationId: "operation-1",
  });
  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "issue_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    githubCommentId: 1234,
  });
  expect(published).toEqual([
    {
      repository: { owner: "mikan-919", name: "oriel" },
      issueNumber: 28,
      body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
    },
  ]);
  database.close();
});

test("uses the persisted request identity to avoid posting the same reply twice", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const result = Promise.withResolvers<{ id: number }>();
  let createCalls = 0;
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createIssueComment: async () => {
        createCalls += 1;
        return result.promise;
      },
    }),
    newOperationId: () => "operation-1",
  });

  const firstAccepted = await service.accept(request);
  const secondAccepted = await service.accept(request);

  expect(secondAccepted).toEqual(firstAccepted);
  result.resolve({ id: 1234 });
  await service.waitForOutcome("operation-1");
  expect(createCalls).toBe(1);
  database.close();
});

test("reports a known GitHub rejection to the harness", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createIssueComment: async () => {
        throw new GitHubIssueCommentRejectedError("forbidden");
      },
    }),
    newOperationId: () => "operation-1",
  });

  await service.accept(request);

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "issue_comment.rejected",
    requestId: "request-1",
    operationId: "operation-1",
    reason: "github_rejected",
  });
  database.close();
});

test("requires reconciliation instead of blindly retrying an unknown GitHub result", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createIssueComment: async () => {
        throw new Error("connection lost");
      },
    }),
    newOperationId: () => "operation-1",
  });

  await service.accept(request);

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "issue_comment.reconciliation_required",
    requestId: "request-1",
    operationId: "operation-1",
  });
  expect(outbox.find("operation-1")?.status).toBe("reconciliation_required");
  database.close();
});

test("reconciliation only selects this actor's exact expected body digest", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const deletedCommentIds: number[] = [];
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createIssueComment: async () => {
        throw new Error("connection lost");
      },
      listIssueComments: async () => [
        {
          id: 1234,
          body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
          authorLogin: "oriel-bot",
        },
        {
          id: 1233,
          body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
          authorLogin: "a-human",
        },
        {
          id: 1235,
          body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->\n",
          authorLogin: "oriel-bot",
        },
      ],
      deleteIssueComment: async ({ id }) => {
        deletedCommentIds.push(id);
      },
    }),
    newOperationId: () => "operation-1",
  });

  await service.accept(request);

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "issue_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    githubCommentId: 1234,
  });
  expect(deletedCommentIds).toEqual([]);
  expect(outbox.find("operation-1")?.bodyDigest).toMatch(/^[0-9a-f]{64}$/);
  database.close();
});

test("reconciles a persisted pending operation after restart without creating a second comment", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  outbox.enqueue({
    ...request,
    operationId: "operation-1",
    githubActorLogin: null,
    bodyDigest: null,
    status: "pending",
    githubCommentId: null,
  });
  let createCalls = 0;
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createIssueComment: async () => {
        createCalls += 1;
        return { id: 1234 };
      },
      listIssueComments: async () => [
        {
          id: 1234,
          body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
          authorLogin: "oriel-bot",
        },
      ],
    }),
  });

  service.resumePending();

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "issue_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    githubCommentId: 1234,
  });
  expect(createCalls).toBe(0);
  database.close();
});

test("uses the trusted serve GitHub client for the selected Issue", async () => {
  let createdInput: unknown;
  let listedInput: unknown;
  let deletedInput: unknown;
  const publisherAdapter = createOctokitIssueCommentPublisher({
    rest: {
      issues: {
        createComment: async (input: unknown) => {
          createdInput = input;
          return { data: { id: 1234 } };
        },
        listComments: "list-comments" as never,
        deleteComment: async (input: unknown) => {
          deletedInput = input;
        },
      },
    },
    paginate: async (route: unknown, input: unknown) => {
      listedInput = { route, input };
      return [];
    },
  } as unknown as Octokit);

  await expect(
    publisherAdapter.createIssueComment({
      repository: request.repository,
      issueNumber: 28,
      body: "Agent reply",
    }),
  ).resolves.toEqual({ id: 1234 });
  await publisherAdapter.listIssueComments({
    repository: request.repository,
    issueNumber: 28,
  });
  await publisherAdapter.deleteIssueComment({
    repository: request.repository,
    id: 1234,
  });

  expect(createdInput).toEqual({
    owner: "mikan-919",
    repo: "oriel",
    issue_number: 28,
    body: "Agent reply",
  });
  expect(listedInput).toEqual({
    route: "list-comments",
    input: {
      owner: "mikan-919",
      repo: "oriel",
      issue_number: 28,
      per_page: 100,
    },
  });
  expect(deletedInput).toEqual({
    owner: "mikan-919",
    repo: "oriel",
    comment_id: 1234,
  });
});

test("resends after re-reading external state that shows no comment for an unknown result", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const publishedBodies: string[] = [];
  let listCalls = 0;
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createIssueComment: async ({ body }) => {
        publishedBodies.push(body);

        if (publishedBodies.length === 1) {
          throw new Error("connection lost");
        }

        return { id: 1234 };
      },
      listIssueComments: async () => {
        listCalls += 1;

        return listCalls === 1
          ? []
          : [
              {
                id: 1234,
                body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
                authorLogin: "oriel-bot",
              },
            ];
      },
    }),
    newOperationId: () => "operation-1",
  });

  await service.accept(request);

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "issue_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    githubCommentId: 1234,
  });
  expect(publishedBodies).toHaveLength(2);
  database.close();
});

test("keeps a single logical reply when the same comment was posted twice", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  const deletedCommentIds: number[] = [];
  const duplicated = {
    body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
    authorLogin: "oriel-bot",
  };
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createIssueComment: async () => {
        throw new Error("connection lost");
      },
      listIssueComments: async () => [
        { id: 1235, ...duplicated },
        { id: 1234, ...duplicated },
        { id: 1236, ...duplicated },
      ],
      deleteIssueComment: async ({ id }) => {
        deletedCommentIds.push(id);
      },
    }),
    newOperationId: () => "operation-1",
  });

  await service.accept(request);

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "issue_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    githubCommentId: 1234,
  });
  expect(deletedCommentIds).toEqual([1235, 1236]);
  database.close();
});

test("re-checks external state under the new acquisition ID after reconnecting", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createIssueCommentOutbox(database);
  outbox.enqueue({
    ...request,
    operationId: "operation-1",
    githubActorLogin: "oriel-bot",
    bodyDigest: null,
    status: "reconciliation_required",
    githubCommentId: null,
  });
  const confirmedJobLeaseIds: string[] = [];
  let createCalls = 0;
  const service = createIssueCommentService({
    outbox,
    ownershipVerifier: {
      hasCurrentJobOwnership: ({ jobLeaseId }) => {
        confirmedJobLeaseIds.push(jobLeaseId);
        return jobLeaseId === "lease-2";
      },
    },
    publisher: publisher({
      createIssueComment: async () => {
        createCalls += 1;
        return { id: 1234 };
      },
      listIssueComments: async () => [
        {
          id: 1234,
          body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
          authorLogin: "oriel-bot",
        },
      ],
    }),
  });

  await service.resumePending({
    jobId: "issue-conversation-1",
    jobLeaseId: "lease-2",
    repository: request.repository,
    issueNumber: 28,
  });

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "issue_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    githubCommentId: 1234,
  });
  expect(confirmedJobLeaseIds).toEqual(["lease-2"]);
  expect(createCalls).toBe(0);
  expect(outbox.find("operation-1")?.jobLeaseId).toBe("lease-2");
  database.close();
});

function publisher(
  overrides: Partial<GitHubIssueCommentPublisher> = {},
): GitHubIssueCommentPublisher {
  return {
    createIssueComment: async () => ({ id: 1234 }),
    getActorLogin: async () => "oriel-bot",
    listIssueComments: async () => [],
    deleteIssueComment: async () => {},
    ...overrides,
  };
}
