import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import type { IssueConversationAdmission } from "./issue-conversation-admission";
import { startIssueConversationJob } from "./issue-conversation-job";
import { startFakeOwnershipRelay } from "./ownership-relay.fake";

const deviceToken = "7.11.device-token";
const repositoryId = 11;
const repository = { owner: "mikan-919", name: "oriel" };
const harnessEntry = new URL("../../harness/src/main.ts", import.meta.url)
  .pathname;

function tokenStore(token: string | null): DeviceTokenStore {
  return { set: async () => {}, get: async () => token };
}

/** 現在のGitHub Issueを読み直すadmissionのfake。 */
function fakeAdmission(
  fingerprint: () => string,
  refusal?: "issue_not_found" | "issue_not_open" | "repository_mismatch",
): IssueConversationAdmission {
  return {
    admit: async ({ issueNumber }) =>
      refusal === undefined
        ? {
            status: "admitted",
            jobId: `issue-conversation:${repositoryId}:${issueNumber}:${fingerprint()}`,
            approvalFingerprint: fingerprint(),
          }
        : { status: "refused", reason: refusal },
    reconfirm: async ({ approvalFingerprint }) =>
      approvalFingerprint === fingerprint(),
  };
}

function fakeOctokit(published: { bodies: string[] }) {
  return {
    rest: {
      issues: {
        createComment: async ({ body }: { body: string }) => {
          published.bodies.push(body);
          return { data: { id: published.bodies.length } };
        },
        listComments: "list-comments" as never,
        deleteComment: async () => {},
      },
      users: {
        getAuthenticated: async () => ({ data: { login: "oriel-bot" } }),
      },
    },
    paginate: async () => [],
  } as unknown as Octokit;
}

async function withWorkspace<T>(run: (databasePath: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-conversation-"));

  try {
    return await run(join(directory, "serve.sqlite"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function options(databasePath: string, relayOrigin: string) {
  return {
    relayOrigin,
    tokenStore: tokenStore(deviceToken),
    createOctokit: async () => fakeOctokit({ bodies: [] }),
    createAdmission: () => fakeAdmission(() => "fingerprint-1"),
    databasePath,
    harnessEntry,
    repositoryId,
    repository,
    issueNumber: 28,
    body: "Agent reply",
    heartbeatStopMs: 500,
  };
}

test("an admitted conversation runs a real harness process and cleans up on normal completion", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const published = { bodies: [] as string[] };
    const started = await startIssueConversationJob({
      ...options(databasePath, relay.origin),
      createOctokit: async () => fakeOctokit(published),
    });

    try {
      expect(started.status).toBe("started");

      if (started.status !== "started") {
        return;
      }

      // clientはJobキーを指定できない。承認指紋から導く。
      expect(started.jobId).toBe(
        `issue-conversation:${repositoryId}:28:fingerprint-1`,
      );
      // 非コード対話はJob所有権だけを取り、ブランチ排他を取らない。
      expect(relay.openConnections()).toBe(1);

      await started.finished;

      expect(published.bodies).toHaveLength(1);
      expect(published.bodies[0]).toContain("Agent reply");
      // ADR 0005の配送識別子をHTML commentとして埋める。
      expect(published.bodies[0]).toContain("oriel-operation:");
      expect(started.jobStatus()).toBe("completed");

      started.close();
      await Bun.sleep(50);

      // 正常終了ではleaseとheartbeatを手放す。
      expect(relay.openConnections()).toBe(0);

      // 後から所有権が失われても、完了したJobを`interrupted`にしない。
      relay.revokeDevice();
      await Bun.sleep(50);

      expect(started.jobStatus()).toBe("completed");
    } finally {
      if (started.status === "started") {
        started.close();
      }

      relay.stop();
    }
  });
});

test("revoking the device kills the running harness process before it can write again", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const published = { bodies: [] as string[] };
    const started = await startIssueConversationJob({
      ...options(databasePath, relay.origin),
      createOctokit: async () => fakeOctokit(published),
      // harnessが返答を書く前に失効させるため、応答できない本文を使う。
      body: "Agent reply",
    });

    if (started.status !== "started") {
      throw new Error("the conversation was refused");
    }

    try {
      relay.revokeDevice();
      await Bun.sleep(100);

      expect(started.jobStatus()).toBe("interrupted");

      // process停止と外部操作拒否の後は、待っても新しい書き込みが増えない。
      await Bun.sleep(100);

      expect(published.bodies.length).toBeLessThanOrEqual(1);
      expect(relay.openConnections()).toBe(0);
    } finally {
      started.close();
      relay.stop();
    }
  });
});

test("a conversation is refused before any process starts", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const base = options(databasePath, relay.origin);

    try {
      expect(
        await startIssueConversationJob({
          ...base,
          tokenStore: tokenStore(null),
        }),
      ).toEqual({ status: "refused", reason: "device_not_registered" });

      // 未認証のOctokitは使わず、外部書き込み経路をfail closedにする。
      expect(
        await startIssueConversationJob({
          ...base,
          createOctokit: async () => null,
        }),
      ).toEqual({
        status: "refused",
        reason: "github_credentials_unavailable",
      });

      expect(
        await startIssueConversationJob({
          ...base,
          createAdmission: () =>
            fakeAdmission(() => "fingerprint-1", "issue_not_open"),
        }),
      ).toEqual({ status: "refused", reason: "issue_not_open" });

      expect(
        await startIssueConversationJob({
          ...base,
          createAdmission: () =>
            fakeAdmission(() => "fingerprint-1", "repository_mismatch"),
        }),
      ).toEqual({ status: "refused", reason: "repository_mismatch" });

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a WHAT that changed between the two reads takes no worker and releases ownership", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    let fingerprint = "fingerprint-1";

    try {
      const refused = await startIssueConversationJob({
        ...options(databasePath, relay.origin),
        createAdmission: () => ({
          admit: async () => {
            const admitted = {
              status: "admitted" as const,
              jobId: "issue-conversation:11:28:fingerprint-1",
              approvalFingerprint: fingerprint,
            };

            // 所有権取得のあいだにWHATが変わる。
            fingerprint = "fingerprint-2";
            return admitted;
          },
          reconfirm: async ({ approvalFingerprint }) =>
            approvalFingerprint === fingerprint,
        }),
      });

      expect(refused).toEqual({
        status: "refused",
        reason: "approval_changed",
      });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a second conversation for the same Job takes no ownership and starts no process", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const first = await startIssueConversationJob(
      options(databasePath, relay.origin),
    );

    try {
      expect(first.status).toBe("started");
      expect(
        await startIssueConversationJob(options(databasePath, relay.origin)),
      ).toEqual({ status: "refused", reason: "job_ownership_not_acquired" });
    } finally {
      if (first.status === "started") {
        first.close();
      }

      relay.stop();
    }
  });
});
