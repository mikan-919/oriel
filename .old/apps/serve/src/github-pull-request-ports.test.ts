import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import { createGitHubPullRequestPorts } from "./github-pull-request-ports";

const repository = { owner: "mikan-919", name: "oriel" };

function port(overrides: {
  paginate?: (route: string, params: unknown) => Promise<unknown[]>;
  create?: (params: unknown) => Promise<{ data: { number: number } }>;
  updatePull?: (params: unknown) => Promise<unknown>;
  createComment?: (params: unknown) => Promise<unknown>;
}) {
  const octokit = {
    paginate: overrides.paginate ?? (async () => []),
    rest: {
      pulls: {
        create: overrides.create ?? (async () => ({ data: { number: 1 } })),
        update: overrides.updatePull ?? (async () => ({})),
      },
      issues: {
        createComment: overrides.createComment ?? (async () => ({})),
      },
    },
  } as unknown as Octokit;

  return createGitHubPullRequestPorts({ octokit, repository });
}

test("lists open pull requests scoped to head and base", async () => {
  let calledWith: unknown;
  const ports = port({
    paginate: async (route, params) => {
      calledWith = { route, params };

      return [{ number: 3 }, { number: 7 }];
    },
  });

  expect(
    await ports.listOpenPullRequestsByHeadBase({
      head: "oriel/ENG-1-gh-1-abc",
      base: "main",
    }),
  ).toEqual([{ number: 3 }, { number: 7 }]);
  expect(calledWith).toMatchObject({
    route: "GET /repos/{owner}/{repo}/pulls",
    params: {
      owner: "mikan-919",
      repo: "oriel",
      head: "mikan-919:oriel/ENG-1-gh-1-abc",
      base: "main",
      state: "open",
    },
  });
});

test("becomes null instead of throwing when the list call fails", async () => {
  const ports = port({
    paginate: async () => {
      throw new Error("network");
    },
  });

  expect(
    await ports.listOpenPullRequestsByHeadBase({ head: "h", base: "main" }),
  ).toBeNull();
});

test("creates a pull request and returns its number", async () => {
  let calledWith: unknown;
  const ports = port({
    create: async (params) => {
      calledWith = params;

      return { data: { number: 42 } };
    },
  });

  expect(
    await ports.createPullRequest({
      head: "oriel/ENG-1-gh-1-abc",
      base: "main",
      title: "WHAT title",
      body: "Closes #1",
    }),
  ).toEqual({ number: 42 });
  expect(calledWith).toMatchObject({
    owner: "mikan-919",
    repo: "oriel",
    head: "oriel/ENG-1-gh-1-abc",
    base: "main",
    title: "WHAT title",
    body: "Closes #1",
  });
});

test("treats a duplicate-creation race as already_exists rather than failing", async () => {
  const ports = port({
    create: async () => {
      throw {
        status: 422,
        message: "A pull request already exists for mikan-919:oriel-branch.",
      };
    },
  });

  expect(
    await ports.createPullRequest({
      head: "h",
      base: "main",
      title: "t",
      body: "b",
    }),
  ).toBe("already_exists");
});

test("becomes null for other creation failures", async () => {
  const ports = port({
    create: async () => {
      throw new Error("network");
    },
  });

  expect(
    await ports.createPullRequest({
      head: "h",
      base: "main",
      title: "t",
      body: "b",
    }),
  ).toBeNull();
});

test("comments and closes a duplicate pull request", async () => {
  const commentCalls: unknown[] = [];
  const updateCalls: unknown[] = [];
  const ports = port({
    createComment: async (params) => {
      commentCalls.push(params);
    },
    updatePull: async (params) => {
      updateCalls.push(params);
    },
  });

  expect(
    await ports.closeDuplicatePullRequest({ number: 9, canonicalNumber: 3 }),
  ).toBe(true);
  expect(commentCalls).toEqual([
    {
      owner: "mikan-919",
      repo: "oriel",
      issue_number: 9,
      body: expect.stringContaining("#3"),
    },
  ]);
  expect(updateCalls).toEqual([
    { owner: "mikan-919", repo: "oriel", pull_number: 9, state: "closed" },
  ]);
});

test("becomes false instead of throwing when closing a duplicate fails", async () => {
  const ports = port({
    updatePull: async () => {
      throw new Error("network");
    },
  });

  expect(
    await ports.closeDuplicatePullRequest({ number: 9, canonicalNumber: 3 }),
  ).toBe(false);
});
