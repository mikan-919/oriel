import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { LinearTriageLinkRequest } from "@mikan-919/oriel-contracts";

import { ensureLinearTriageLink } from "./linear-triage-link";
import type { LinearDiscoveryReader } from "./linear-approval";
import type { LinearTriageWriter } from "./linear-triage-writer";
import { openServeLocalState } from "./local-state";

const request: LinearTriageLinkRequest = {
  type: "linear_triage_link.request",
  requestId: "req-1",
  jobId: "what-confirmation:11:28:comment-1",
  jobLeaseId: "lease-1",
  repository: { owner: "acme", name: "widgets" },
  issueNumber: 28,
  title: "Slow dashboard",
  description: "The dashboard should load in under 2s.",
};
const githubIssueUrl = "https://github.com/acme/widgets/issues/28";
const linearTeamId = "team-1";

async function withDatabase<T>(run: (database: Database) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-linear-triage-link-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));

  try {
    return await run(database);
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function fakeDiscovery(
  results: () => { issueId: string }[] | null,
): LinearDiscoveryReader {
  return { findIssuesByAttachmentUrl: async () => results() };
}

test("returns the already-linked issue without creating anything", async () => {
  await withDatabase(async (database) => {
    const created: unknown[] = [];
    const writer: LinearTriageWriter = {
      createTriageIssue: async (input) => {
        created.push(input);
        return { issueId: "should-not-be-called" };
      },
      createAttachment: async () => true,
    };

    const event = await ensureLinearTriageLink({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      discovery: fakeDiscovery(() => [{ issueId: "existing-issue" }]),
      writer,
      linearTeamId,
      githubIssueUrl,
      request,
    });

    expect(event).toEqual({
      type: "linear_triage_link.completed",
      requestId: "req-1",
      linearIssueId: "existing-issue",
    });
    expect(created).toEqual([]);
  });
});

test("refuses as ambiguous when more than one Linear issue is already linked", async () => {
  await withDatabase(async (database) => {
    const writer: LinearTriageWriter = {
      createTriageIssue: async () => ({ issueId: "x" }),
      createAttachment: async () => true,
    };

    const event = await ensureLinearTriageLink({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      discovery: fakeDiscovery(() => [{ issueId: "a" }, { issueId: "b" }]),
      writer,
      linearTeamId,
      githubIssueUrl,
      request,
    });

    expect(event).toEqual({
      type: "linear_triage_link.rejected",
      requestId: "req-1",
      reason: "ambiguous_existing_link",
    });
  });
});

test("creates a Triage issue and attaches it when none is linked yet", async () => {
  await withDatabase(async (database) => {
    let linked = false;
    const created: {
      teamId: string;
      title: string;
      description: string;
      clientId: string;
    }[] = [];
    const attached: { issueId: string; url: string; title: string }[] = [];
    const writer: LinearTriageWriter = {
      createTriageIssue: async (input) => {
        created.push(input);
        return { issueId: "new-issue" };
      },
      createAttachment: async (input) => {
        attached.push(input);
        linked = true;
        return true;
      },
    };

    const event = await ensureLinearTriageLink({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      discovery: {
        findIssuesByAttachmentUrl: async () =>
          linked ? [{ issueId: "new-issue" }] : [],
      },
      writer,
      linearTeamId,
      githubIssueUrl,
      request,
    });

    expect(event).toEqual({
      type: "linear_triage_link.completed",
      requestId: "req-1",
      linearIssueId: "new-issue",
    });
    expect(created).toEqual([
      {
        teamId: linearTeamId,
        title: request.title,
        description: request.description,
        clientId: expect.any(String),
      },
    ]);
    expect(attached).toEqual([
      { issueId: "new-issue", url: githubIssueUrl, title: request.title },
    ]);
  });
});

test("reports linear_rejected and does not retry blindly when the attachment never appears", async () => {
  await withDatabase(async (database) => {
    const writer: LinearTriageWriter = {
      createTriageIssue: async () => ({ issueId: "orphan-issue" }),
      createAttachment: async () => false,
    };

    const event = await ensureLinearTriageLink({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => true },
      discovery: fakeDiscovery(() => []),
      writer,
      linearTeamId,
      githubIssueUrl,
      request,
    });

    expect(event).toEqual({
      type: "linear_triage_link.rejected",
      requestId: "req-1",
      reason: "linear_rejected",
    });
  });
});

test("refuses without reading Linear when ownership is not current", async () => {
  await withDatabase(async (database) => {
    let discoveryCalled = false;
    const writer: LinearTriageWriter = {
      createTriageIssue: async () => ({ issueId: "x" }),
      createAttachment: async () => true,
    };

    const event = await ensureLinearTriageLink({
      database,
      ownershipVerifier: { hasCurrentJobOwnership: async () => false },
      discovery: {
        findIssuesByAttachmentUrl: async () => {
          discoveryCalled = true;
          return [];
        },
      },
      writer,
      linearTeamId,
      githubIssueUrl,
      request,
    });

    expect(event).toEqual({
      type: "linear_triage_link.rejected",
      requestId: "req-1",
      reason: "ownership_not_current",
    });
    expect(discoveryCalled).toBe(false);
  });
});
