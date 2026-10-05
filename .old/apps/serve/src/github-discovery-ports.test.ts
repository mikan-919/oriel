import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import { createGitHubOpenIssuePort } from "./github-discovery-ports";

const repository = { owner: "mikan-919", name: "oriel" };

function port(
  paginate: (route: string, params: unknown) => Promise<unknown[]>,
) {
  const octokit = { paginate } as unknown as Octokit;

  return createGitHubOpenIssuePort({ octokit, repository });
}

test("lists open issues and excludes pull requests", async () => {
  const listed = port(async () => [
    { number: 1, html_url: "https://github.com/mikan-919/oriel/issues/1" },
    {
      number: 2,
      html_url: "https://github.com/mikan-919/oriel/pull/2",
      pull_request: { url: "https://api.github.com/.../pulls/2" },
    },
    { number: 3, html_url: "https://github.com/mikan-919/oriel/issues/3" },
  ]);

  expect(await listed.listOpenIssues()).toEqual([
    { number: 1, url: "https://github.com/mikan-919/oriel/issues/1" },
    { number: 3, url: "https://github.com/mikan-919/oriel/issues/3" },
  ]);
});

test("passes through paginate calls across multiple pages", async () => {
  let calls = 0;
  const listed = port(async (route, params) => {
    calls += 1;
    expect(route).toBe("GET /repos/{owner}/{repo}/issues");
    expect(params).toMatchObject({
      owner: "mikan-919",
      repo: "oriel",
      state: "open",
    });

    return [
      { number: 1, html_url: "https://github.com/mikan-919/oriel/issues/1" },
    ];
  });

  expect(await listed.listOpenIssues()).toEqual([
    { number: 1, url: "https://github.com/mikan-919/oriel/issues/1" },
  ]);
  expect(calls).toBe(1);
});

test("drops issues missing a usable number or URL", async () => {
  const listed = port(async () => [
    { number: 0, html_url: "https://github.com/mikan-919/oriel/issues/0" },
    { number: 5, html_url: "" },
    { html_url: "https://github.com/mikan-919/oriel/issues/6" },
  ]);

  expect(await listed.listOpenIssues()).toEqual([]);
});

test("becomes null instead of throwing when the API call fails", async () => {
  const listed = port(async () => {
    throw new Error("network");
  });

  expect(await listed.listOpenIssues()).toBeNull();
});
