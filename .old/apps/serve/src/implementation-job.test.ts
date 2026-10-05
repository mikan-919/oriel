import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import {
  approvalFingerprint,
  canonicalBranchName,
} from "./approval-fingerprint";
import type { DeviceTokenStore } from "./device-registration";
import type {
  ImplementationApprovalPorts,
  SealOutcome,
} from "./implementation-admission";
import { startImplementationJob } from "./implementation-job";
import type { StartImplementationWorkerOptions } from "./implementation-worker";
import type { LinearInProgressPorts } from "./linear-progress";
import type { LinearReviewStatePorts } from "./linear-review-state";
import { openServeLocalState } from "./local-state";
import { createTranscriptStore } from "./transcript-store";
import { createRelayOwnershipConnection } from "./ownership-connection";
import { startFakeOwnershipRelay } from "./ownership-relay.fake";
import type { LinearApprovalStatePorts } from "./return-to-triage";

const deviceToken = "7.11.device-token";
const repositoryId = 11;
const repository = { owner: "mikan-919", name: "oriel" };
const repositoryNodeId = "R_kgDOABCDEF";
const issueNodeId = "I_kwDOABCDEF";
const linearIssueId = "0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f";
const baseOid = "1111111111111111111111111111111111111111";
const harnessEntry = new URL("../../harness/src/main.ts", import.meta.url)
  .pathname;

function fingerprintOf(githubTitle: string) {
  return approvalFingerprint({
    repositoryId: repositoryNodeId,
    githubIssueNodeId: issueNodeId,
    githubTitle,
    githubBody: "WHAT body",
    linearIssueUuid: linearIssueId,
    linearTitle: "HOW title",
    linearDescription: "HOW description",
  });
}

const canonicalBranch = canonicalBranchName({
  linearIdentifier: "ENG-12",
  githubIssueNumber: 28,
  approvalFingerprint: fingerprintOf("WHAT title"),
});

function tokenStore(token: string | null): DeviceTokenStore {
  return { set: async () => {}, get: async () => token };
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

/** 取り込み先branchに置かれた、自立Jobを許可する実行設定。 */
const autonomousConfig = `schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
  verification:
    - ["bun", "run", "typecheck"]
    - ["bun", "test"]
`;

/** 読み直しのたびに現在値を差し替えられるports。呼び出し順も記録する。 */
function fakePorts(
  options: {
    githubTitleByRead?: (read: number) => string;
    /** 取り込み先branchの`.oriel.yaml`。読めない場合を不存在と区別する。 */
    executionConfig?: string | "absent" | "unreadable";
    targetBaseOidByRead?: (read: number) => string;
    stateName?: string;
    seal?: SealOutcome;
    /** 封印の直後に、別のworkerがcanonical refを動かした場合。 */
    movesSealedRefTo?: string;
    /** 同じ承認指紋のブランチが既に存在する場合の先端。 */
    existingCanonicalOid?: string;
    /** 引き継ぎ判断の後に、その先端が動いた場合。 */
    movesAdoptedRefTo?: string;
  } = {},
) {
  const calls: string[] = [];
  const refs: Record<string, string> = {};
  let reads = 0;
  let refReads = 0;
  const title = options.githubTitleByRead ?? (() => "WHAT title");
  const targetBaseOid = options.targetBaseOidByRead ?? (() => baseOid);

  if (options.existingCanonicalOid !== undefined) {
    refs[`refs/heads/${canonicalBranch}`] = options.existingCanonicalOid;
  }

  const configFileReads: { oid: string; path: string }[] = [];
  const ports: ImplementationApprovalPorts = {
    readTargetBaseFile: async (oid, path) => {
      configFileReads.push({ oid, path });

      const configured = options.executionConfig ?? autonomousConfig;

      if (configured === "absent") {
        return { status: "absent" };
      }

      return configured === "unreadable"
        ? { status: "unknown" }
        : { status: "present", content: configured };
    },
    readLinearIssue: async () => {
      reads += 1;
      calls.push(`read:${reads}`);

      return {
        issueId: linearIssueId,
        identifier: "ENG-12",
        title: "HOW title",
        description: "HOW description",
        stateName: options.stateName ?? "Todo",
        attachmentUrls: ["https://github.com/mikan-919/oriel/issues/28"],
      };
    },
    resolveGitHubIssueByAttachmentUrl: async () => ({
      issueNumber: 28,
      issueNodeId,
      repositoryNodeId,
      title: title(reads),
      body: "WHAT body",
      state: "open",
    }),
    readTargetBase: async () => ({
      ref: "refs/heads/main",
      oid: targetBaseOid(reads),
    }),
    readRef: async (ref) => {
      refReads += 1;

      if (!(ref in refs)) {
        return { status: "absent" };
      }

      const oid = refs[ref]!;

      // 引き継ぎを決めた後の読み直しで、別のworkerが先端を動かした場合。
      if (options.movesAdoptedRefTo !== undefined && refReads > 1) {
        return { status: "present", oid: options.movesAdoptedRefTo };
      }

      return { status: "present", oid };
    },
    listOpenPullRequestHeadRefs: async () => [],
    checkRefFormat: async () => true,
    updateRefsAtomically: async ({ canonicalRef, expectedBaseOid }) => {
      calls.push("seal");

      const outcome = options.seal ?? "sealed";

      if (outcome === "sealed") {
        refs[canonicalRef] = options.movesSealedRefTo ?? expectedBaseOid;
      }

      return outcome;
    },
  };

  return { ports, calls, refs, configFileReads };
}

/** Linear stateの現在値と、状態反映のattemptを記録するfake。 */
function fakeLinearState({
  movable = true,
  stateName = "Todo" as string | null,
} = {}) {
  const moves: string[] = [];
  let current = stateName;

  return {
    moves,
    state: () => current,
    ports: {
      readLinearState: async () => current,
      moveToTriage: async (linearIssueId: string) => {
        moves.push(linearIssueId);

        if (!movable) {
          return false;
        }

        current = "Triage";

        return true;
      },
      moveToInProgress: async (linearIssueId: string) => {
        moves.push(`in-progress:${linearIssueId}`);

        if (!movable) {
          return false;
        }

        current = "In Progress";

        return true;
      },
      // teamに一意なレビュー用stateが無い既定値。実際の反映は
      // linear-review-state.test.tsが確かめる。
      readReviewStateCandidate: async () => "none" as const,
      moveToStateId: async () => false,
    },
  };
}

async function withWorkspace<T>(run: (databasePath: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-implementation-"));

  try {
    return await run(join(directory, "serve.sqlite"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/**
 * admissionの順序を確かめるためのworker。実際のworktreeとGitは
 * `implementation-worktree.test.ts`が端から端まで確かめる。
 */
function fakeWorker(started: StartImplementationWorkerOptions[]) {
  return async (workerOptions: StartImplementationWorkerOptions) => {
    started.push(workerOptions);

    return {
      status: "started" as const,
      worktreePath: "/worktrees/job",
      worktreeOid: workerOptions.start.canonicalOid,
      finished: Promise.resolve(),
      jobStatus: () => "running",
      close: async () => {
        workerOptions.release();
      },
      requestStop: () => {},
    };
  };
}

/** `serve`だけが持つ提供元への接続。harnessへは渡らない。 */
const modelProvider = {
  // eslint-disable-next-line require-yield
  stream: async function* () {
    throw new Error("no model is reachable in this test");
  },
};

function options(
  databasePath: string,
  relayOrigin: string,
  ports: ImplementationApprovalPorts,
  startedWorkers: StartImplementationWorkerOptions[] = [],
  linearApprovalState: LinearApprovalStatePorts &
    LinearInProgressPorts &
    LinearReviewStatePorts = fakeLinearState().ports,
  getModelCapabilities: () => Promise<{
    reasoning: boolean;
    input: readonly string[];
    contextWindow: number;
    maxTokens: number;
  } | null> = async () => null,
) {
  return {
    model: { provider: "lm-studio", id: "local-model" },
    modelProvider,
    getModelCapabilities,
    linearApprovalState,
    relayOrigin,
    tokenStore: tokenStore(deviceToken),
    createOctokit: async () => fakeOctokit({ bodies: [] }),
    createPorts: () => ports,
    databasePath,
    harnessEntry,
    repositoryId,
    repository,
    linearIssueId,
    heartbeatStopMs: 500,
    repositoryRoot: "/repository",
    worktreesRoot: "/worktrees",
    remote: "origin",
    resolveCredential: async () => null,
    startWorker: fakeWorker(startedWorkers),
    // このtest群のfake workerは"completed"を報告しないため、Pull Request作成は
    // 呼ばれない。型合わせのためだけの既定値。
    createPullRequestOctokit: async () => null,
    createPullRequestPorts: () => null,
  };
}

test("a fully admitted approval seals the branch after ownership and only then starts a worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports, calls, refs } = fakePorts();
    const startedWorkers: StartImplementationWorkerOptions[] = [];
    const started = await startImplementationJob(
      options(databasePath, relay.origin, ports, startedWorkers),
    );

    try {
      expect(started.status).toBe("started");

      if (started.status !== "started") {
        return;
      }

      // Job識別子とcanonicalブランチはclientではなく現在値から導く。
      expect(started.jobId).toBe(
        `implementation:${repositoryId}:28:${fingerprintOf("WHAT title")}`,
      );
      expect(started.canonicalBranch).toBe(canonicalBranch);
      expect(started.branchLeaseId).toEqual(expect.any(String));
      expect(relay.openConnections()).toBe(2);
      expect(refs[`refs/heads/${canonicalBranch}`]).toBe(baseOid);

      // 先行read、所有権取得後のread、封印、封印後のread、In Progress反映の
      // 直前の再調停の順。
      expect(calls).toEqual(["read:1", "read:2", "seal", "read:3", "read:4"]);

      await started.finished;

      // workerは封印済みcanonicalブランチと、承認済みWHAT/HOWだけを受け取る。
      expect(startedWorkers).toHaveLength(1);
      expect(startedWorkers[0]!.start).toEqual({
        type: "implementation.start",
        jobId: started.jobId,
        jobLeaseId: expect.any(String),
        branchLeaseId: started.branchLeaseId,
        approvalFingerprint: fingerprintOf("WHAT title"),
        canonicalBranch,
        canonicalOid: baseOid,
        adopted: false,
        model: { provider: "lm-studio", id: "local-model" },
        what: { title: "WHAT title", body: "WHAT body" },
        how: { title: "HOW title", description: "HOW description" },
        // 検証commandはtarget branch版の`.oriel.yaml`だけを正本とする。
        verification: [
          ["bun", "run", "typecheck"],
          ["bun", "test"],
        ],
      });
      // 統合と再検証のために、確認した取り込み先の参照とOIDもworkerへ渡す。
      expect(startedWorkers[0]!.targetBase).toEqual({
        ref: "refs/heads/main",
        oid: baseOid,
      });
      expect(startedWorkers[0]!.binding).toMatchObject({
        branchKey: `${repositoryId}/${canonicalBranch}`,
        approvalFingerprint: fingerprintOf("WHAT title"),
      });
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("a completed worker creates a Pull Request and reflects the review state", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts();
    const reviewLinear = fakeLinearState();
    const base = options(
      databasePath,
      relay.origin,
      ports,
      [],
      reviewLinear.ports,
    );
    const ensureCalls: unknown[] = [];

    const started = await startImplementationJob({
      ...base,
      startWorker: async (workerOptions) => ({
        status: "started" as const,
        worktreePath: "/worktrees/job",
        worktreeOid: workerOptions.start.canonicalOid,
        finished: Promise.resolve(),
        jobStatus: () => "completed",
        close: async () => {
          workerOptions.release();
        },
        requestStop: () => {},
      }),
      createPullRequestOctokit: async () => fakeOctokit({ bodies: [] }),
      createPullRequestPorts: () => ({
        listOpenPullRequestsByHeadBase: async (input) => {
          ensureCalls.push({ op: "list", input });

          return [];
        },
        createPullRequest: async (input) => {
          ensureCalls.push({ op: "create", input });

          return { number: 7 };
        },
        closeDuplicatePullRequest: async () => true,
      }),
    });

    try {
      expect(started.status).toBe("started");

      if (started.status !== "started") {
        return;
      }

      await started.finished;

      // headはcanonical branch、baseはtarget baseの表示branch名だけを渡す。
      expect(ensureCalls).toEqual([
        { op: "list", input: { head: canonicalBranch, base: "main" } },
        {
          op: "create",
          input: {
            head: canonicalBranch,
            base: "main",
            title: "WHAT title",
            body: "Closes #28",
          },
        },
      ]);
      // worker起動直後のIn Progress反映は変わらず行われる。
      expect(reviewLinear.moves).toEqual([`in-progress:${linearIssueId}`]);

      const database = openServeLocalState(databasePath);

      try {
        expect(
          database
            .query(
              `SELECT job_id AS jobId, pr_number AS prNumber, status
               FROM pull_request_watch`,
            )
            .all(),
        ).toEqual([{ jobId: started.jobId, prNumber: 7, status: "watching" }]);

        // 外部操作の状態はWeb UIがJob単位のtranscriptとして確認できる。
        const entries = createTranscriptStore(database).search({
          repository,
          scope: "job",
          jobId: started.jobId,
          query: "",
          limit: 50,
        });

        expect(
          entries.map((entry) => [entry.kind, entry.content]),
        ).toContainEqual([
          "external.linear_in_progress",
          JSON.stringify({ status: "in_progress" }),
        ]);
        expect(
          entries.map((entry) => [entry.kind, entry.content]),
        ).toContainEqual([
          "external.pull_request",
          JSON.stringify({ status: "created", number: 7 }),
        ]);
        expect(
          entries.map((entry) => [entry.kind, entry.content]),
        ).toContainEqual([
          "external.review_state",
          JSON.stringify({ status: "kept_in_progress" }),
        ]);
      } finally {
        database.close();
      }
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("the worker starts only after the current acquisition IDs and the fence are confirmed again", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts();
    const started = await startImplementationJob(
      options(databasePath, relay.origin, ports),
    );

    try {
      expect(started.status).toBe("started");
      // 取得直後の置換隔離、worker開始直前のJob・ブランチ取得IDの再確認と再隔離、
      // In Progress反映の直前のJob取得IDの確認。
      expect(relay.requests()).toEqual([
        { type: "ownership.inspect", kind: "job" },
        { type: "ownership.confirm", kind: "job" },
        { type: "ownership.confirm", kind: "branch" },
        { type: "ownership.inspect", kind: "job" },
        { type: "ownership.confirm", kind: "job" },
      ]);
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("a live Job of a different approval fingerprint in the same Workflow starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    // 同じWorkflowの、異なる承認指紋の旧Jobがまだ接続を持っている。
    const previous = createRelayOwnershipConnection({
      relayOrigin: relay.origin,
      deviceToken,
      jobId: `implementation:${repositoryId}:28:${fingerprintOf("older WHAT")}`,
      heartbeatStopMs: 500,
    });

    try {
      expect(await previous.acquireJobOwnership()).toEqual(expect.any(String));
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, fakePorts().ports),
        ),
      ).toEqual({ status: "refused", reason: "workflow_not_fenced" });

      await Bun.sleep(50);

      // 新Jobは自分の接続だけを返し、旧Jobの接続には触れない。
      expect(relay.openConnections()).toBe(1);
    } finally {
      previous.release();
      relay.stop();
    }
  });
});

test("a live branch exclusivity of a different fingerprint in the same Workflow starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const previous = createRelayOwnershipConnection({
      relayOrigin: relay.origin,
      deviceToken,
      // Job識別子はWorkflowの外だが、ブランチは同じWorkflowを指している。
      jobId: "pull-request:11:28",
      heartbeatStopMs: 500,
    });

    try {
      await previous.acquireJobOwnership();

      expect(
        await previous.acquireBranchExclusivity(
          `${repositoryId}/oriel/ENG-9-gh-28-${fingerprintOf("older WHAT")}`,
        ),
      ).toEqual(expect.any(String));
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, fakePorts().ports),
        ),
      ).toEqual({ status: "refused", reason: "workflow_not_fenced" });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(2);
    } finally {
      previous.release();
      relay.stop();
    }
  });
});

test("an existing branch of the same fingerprint is adopted without writing any ref", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const workInProgressOid = "2".repeat(40);
    const { ports, calls, refs } = fakePorts({
      existingCanonicalOid: workInProgressOid,
      // 取り込み先の前進は同じ承認を失効させない。
      targetBaseOidByRead: (read) => (read < 3 ? baseOid : "3".repeat(40)),
    });
    const started = await startImplementationJob(
      options(databasePath, relay.origin, ports),
    );

    try {
      expect(started.status).toBe("started");

      if (started.status !== "started") {
        return;
      }

      expect(started.adopted).toBe(true);
      expect(started.canonicalOid).toBe(workInProgressOid);
      // 既存Git参照を強制送信、reset、上書きしない。
      expect(calls).toEqual(["read:1", "read:2", "read:3", "read:4"]);
      expect(refs[`refs/heads/${canonicalBranch}`]).toBe(workInProgressOid);
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("an existing branch whose tip moves during admission starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts({
      existingCanonicalOid: "2".repeat(40),
      movesAdoptedRefTo: "4".repeat(40),
    });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "branch_adoption_unavailable" });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a WHAT that changed after ownership seals nothing and starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports, calls } = fakePorts({
      githubTitleByRead: (read) => (read === 1 ? "WHAT title" : "changed"),
    });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({
        status: "refused",
        reason: "approval_changed",
        // 承認対象の不一致は、所有権を確認した`serve`がLinearへ反映する。
        returnedToTriage: "returned",
      });
      expect(calls).toEqual(["read:1", "read:2"]);

      await Bun.sleep(50);

      // ブランチ排他、Job所有権の順に返し、接続を残さない。
      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a WHAT that changed after the seal starts no worker either", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports, calls } = fakePorts({
      githubTitleByRead: (read) => (read === 3 ? "changed" : "WHAT title"),
    });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({
        status: "refused",
        reason: "approval_changed",
        returnedToTriage: "returned",
      });
      expect(calls).toEqual(["read:1", "read:2", "seal", "read:3"]);

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("an API that cannot seal atomically starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts({ seal: "unsupported" });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "branch_seal_unsupported" });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a canonical branch that is not at the sealed tip starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts({ movesSealedRefTo: "9".repeat(40) });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "branch_seal_result_unknown" });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("an approval that is not current Todo takes no ownership at all", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports, calls } = fakePorts({ stateName: "Triage" });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports),
        ),
      ).toEqual({ status: "refused", reason: "linear_state_not_todo" });
      expect(calls).toEqual(["read:1"]);
      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("credentials that the product cannot resolve fail closed before any read", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts();
    const base = options(databasePath, relay.origin, ports);

    try {
      expect(
        await startImplementationJob({ ...base, tokenStore: tokenStore(null) }),
      ).toEqual({ status: "refused", reason: "device_not_registered" });
      expect(
        await startImplementationJob({
          ...base,
          createOctokit: async () => null,
        }),
      ).toEqual({
        status: "refused",
        reason: "github_credentials_unavailable",
      });
      // HOWの正本へ届かないなら、実装Jobを始めない。
      expect(
        await startImplementationJob({ ...base, createPorts: () => null }),
      ).toEqual({
        status: "refused",
        reason: "linear_credentials_unavailable",
      });
      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("a second implementation Job for the same canonical branch is refused", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const first = await startImplementationJob(
      options(databasePath, relay.origin, fakePorts().ports),
    );

    try {
      expect(first.status).toBe("started");

      // 同じJob識別子はJob所有権で、同じ承認指紋の別Jobはブランチ排他で止まる。
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, fakePorts().ports),
        ),
      ).toEqual({ status: "refused", reason: "job_ownership_not_acquired" });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(2);
    } finally {
      if (first.status === "started") {
        first.close();
      }

      relay.stop();
    }
  });
});

test("the execution config is read from the confirmed target base and is the only source of verification", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const advancedBase = "3".repeat(40);
    // 引き継ぎでは、承認の読み直しで確認した最新の取り込み先の版を読む。
    const { ports, configFileReads } = fakePorts({
      existingCanonicalOid: "2".repeat(40),
      targetBaseOidByRead: (read) => (read < 2 ? baseOid : advancedBase),
    });
    const startedWorkers: StartImplementationWorkerOptions[] = [];
    const started = await startImplementationJob(
      options(databasePath, relay.origin, ports, startedWorkers),
    );

    try {
      expect(started.status).toBe("started");
      expect(configFileReads).toEqual([
        { oid: advancedBase, path: ".oriel.yaml" },
      ]);
      expect(startedWorkers[0]!.targetBase).toEqual({
        ref: "refs/heads/main",
        oid: advancedBase,
      });
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("a target base without a usable execution config starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    for (const [executionConfig, reason] of [
      ["absent", "execution_config_missing"],
      ["unreadable", "execution_config_unreadable"],
      // backendもautonomousも明示しない設定は既定値で埋めない。
      ["schemaVersion: 1\n", "execution_config_invalid"],
      // 自立Jobを明示的に許可していない。
      [
        'schemaVersion: 1\nexecution:\n  backend: worktree\n  autonomous: false\n  verification: [["bun", "test"]]\n',
        "execution_config_invalid",
      ],
      // 未知のbackendへfallbackしない。
      [
        'schemaVersion: 1\nexecution:\n  backend: docker\n  autonomous: true\n  verification: [["bun", "test"]]\n',
        "execution_config_invalid",
      ],
      // 検証commandが空なら、検証済みになりようがない。
      [
        "schemaVersion: 1\nexecution:\n  backend: worktree\n  autonomous: true\n  verification: []\n",
        "execution_config_invalid",
      ],
      // 未知のfieldも既定値で無視しない。
      [
        'schemaVersion: 1\nexecution:\n  backend: worktree\n  autonomous: true\n  verification: [["bun", "test"]]\n  network: open\n',
        "execution_config_invalid",
      ],
    ] as const) {
      const relay = startFakeOwnershipRelay(deviceToken);
      const { ports } = fakePorts({ executionConfig });
      const startedWorkers: StartImplementationWorkerOptions[] = [];

      try {
        expect(
          await startImplementationJob(
            options(databasePath, relay.origin, ports, startedWorkers),
          ),
        ).toEqual({ status: "refused", reason });
        expect(startedWorkers).toHaveLength(0);

        await Bun.sleep(50);

        // ブランチ排他、Job所有権の順に返し、接続を残さない。
        expect(relay.openConnections()).toBe(0);
      } finally {
        relay.stop();
      }
    }
  });
});

test("a resolved model that does not satisfy .oriel.yaml's modelCapabilities starts no worker", async () => {
  await withWorkspace(async (databasePath) => {
    const executionConfig = `${autonomousConfig}modelCapabilities:
  reasoning: true
`;
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts({ executionConfig });
    const startedWorkers: StartImplementationWorkerOptions[] = [];

    try {
      expect(
        await startImplementationJob(
          options(
            databasePath,
            relay.origin,
            ports,
            startedWorkers,
            undefined,
            async () => ({
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 8192,
            }),
          ),
        ),
      ).toEqual({ status: "refused", reason: "model_capability_mismatch" });
      expect(startedWorkers).toHaveLength(0);
    } finally {
      relay.stop();
    }
  });
});

test("a resolved model that satisfies .oriel.yaml's modelCapabilities starts a worker", async () => {
  await withWorkspace(async (databasePath) => {
    const executionConfig = `${autonomousConfig}modelCapabilities:
  reasoning: true
`;
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts({ executionConfig });
    const startedWorkers: StartImplementationWorkerOptions[] = [];

    try {
      const started = await startImplementationJob(
        options(
          databasePath,
          relay.origin,
          ports,
          startedWorkers,
          undefined,
          async () => ({
            reasoning: true,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
          }),
        ),
      );

      expect(started.status).toBe("started");

      if (started.status === "started") {
        await started.close();
      }
    } finally {
      relay.stop();
    }
  });
});

test("an approval that no longer matches is returned from Todo to Triage by the owning serve", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const linear = fakeLinearState();
    const { ports } = fakePorts({
      githubTitleByRead: (read) => (read === 1 ? "WHAT title" : "changed"),
    });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports, [], linear.ports),
        ),
      ).toEqual({
        status: "refused",
        reason: "approval_changed",
        returnedToTriage: "returned",
      });

      // 差し戻すのは、現在の所有権を確認した`serve`だけである。
      expect(linear.moves).toEqual([linearIssueId]);
      expect(linear.state()).toBe("Triage");

      // 送信前の試行が、内部の冪等性キーとして永続化されている。
      const database = openServeLocalState(databasePath);

      try {
        expect(
          database
            .query(
              `SELECT operation, linear_issue_id AS linearIssueId, status
               FROM return_to_triage_outbox`,
            )
            .all(),
        ).toEqual([
          {
            operation: "return-to-triage",
            linearIssueId,
            status: "returned",
          },
        ]);

        // 外部操作の状態はWeb UIがJob単位のtranscriptとして確認できる。
        expect(
          createTranscriptStore(database)
            .search({ repository, scope: "local", query: "", limit: 50 })
            .map((entry) => [entry.kind, entry.content]),
        ).toContainEqual([
          "external.returned_to_triage",
          JSON.stringify({ status: "returned" }),
        ]);
      } finally {
        database.close();
      }

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

test("an approval read that shows a changed target after ownership is returned to Triage", async () => {
  for (const [reason, ports] of [
    // 承認そのものが外れた。
    ["linear_state_not_todo", fakePorts({ stateName: "In Progress" })],
    // attachmentからGitHub Issueが一意に解決しなくなった。
    ["github_issue_not_uniquely_attached", fakePorts()],
    // 対象のWHATが閉じられた。
    ["github_issue_not_open", fakePorts()],
  ] as const) {
    await withWorkspace(async (databasePath) => {
      const relay = startFakeOwnershipRelay(deviceToken);
      const linear = fakeLinearState();
      let reads = 0;
      // 先行readだけは通し、所有権を取った後の読み直しで観測する。
      const changing: ImplementationApprovalPorts = {
        ...ports.ports,
        readLinearIssue: async (issueId) => {
          reads += 1;
          const read = await ports.ports.readLinearIssue(issueId);

          return read === null || reads === 1
            ? { ...read!, stateName: "Todo" }
            : read;
        },
        resolveGitHubIssueByAttachmentUrl: async (url) => {
          const issue =
            await ports.ports.resolveGitHubIssueByAttachmentUrl(url);

          if (issue === null || reads === 1) {
            return issue;
          }

          if (reason === "github_issue_not_uniquely_attached") {
            return null;
          }

          return reason === "github_issue_not_open"
            ? { ...issue, state: "closed" }
            : issue;
        },
      };

      try {
        expect(
          await startImplementationJob(
            options(databasePath, relay.origin, changing, [], linear.ports),
          ),
        ).toEqual({
          status: "refused",
          reason: "approval_changed",
          returnedToTriage: "returned",
        });
        // どの経路でも、同じTodo→Triageの収束へ送る。
        expect(linear.moves).toEqual([linearIssueId]);
      } finally {
        relay.stop();
      }
    });
  }
});

test("an approval that cannot be read after ownership is refused without any Linear write", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const linear = fakeLinearState();
    const { ports } = fakePorts();
    let reads = 0;

    try {
      expect(
        await startImplementationJob(
          options(
            databasePath,
            relay.origin,
            {
              ...ports,
              // 二度目の読み直しだけ、HOWの正本へ届かない。
              readLinearIssue: async (issueId) => {
                reads += 1;

                return reads === 1 ? ports.readLinearIssue(issueId) : null;
              },
            },
            [],
            linear.ports,
          ),
        ),
      ).toEqual({ status: "refused", reason: "linear_issue_not_found" });

      // 単なる提供元障害では差し戻さない。
      expect(linear.moves).toEqual([]);
      expect(linear.state()).toBe("Todo");
    } finally {
      relay.stop();
    }
  });
});

test("the started worker moves the approved Linear issue to In Progress", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const linear = fakeLinearState();
    const started = await startImplementationJob(
      options(databasePath, relay.origin, fakePorts().ports, [], linear.ports),
    );

    try {
      expect(started.status).toBe("started");

      if (started.status !== "started") {
        return;
      }

      expect(started.linearState).toBe("in_progress");
      expect(linear.moves).toEqual([`in-progress:${linearIssueId}`]);
      expect(linear.state()).toBe("In Progress");

      // 用途を限った操作記録として、送信前の試行が永続化されている。
      const database = openServeLocalState(databasePath);

      try {
        expect(
          database
            .query(
              `SELECT operation, linear_issue_id AS linearIssueId, status
               FROM linear_progress_outbox`,
            )
            .all(),
        ).toEqual([
          {
            operation: "move-to-in-progress",
            linearIssueId,
            status: "in_progress",
          },
        ]);
      } finally {
        database.close();
      }
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("the reconciliation after start accepts the In Progress state that serve itself reflected", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const linear = fakeLinearState();
    const { ports } = fakePorts();
    // 承認の読み直しが、機械的に反映されたLinear stateの現在値へ追従する。
    const following: ImplementationApprovalPorts = {
      ...ports,
      readLinearIssue: async (issueId) => {
        const read = await ports.readLinearIssue(issueId);

        return read === null
          ? null
          : { ...read, stateName: linear.state() ?? "" };
      },
    };
    const startedWorkers: StartImplementationWorkerOptions[] = [];
    const started = await startImplementationJob(
      options(
        databasePath,
        relay.origin,
        following,
        startedWorkers,
        linear.ports,
      ),
    );

    try {
      expect(started.status).toBe("started");

      if (started.status !== "started") {
        return;
      }

      expect(started.linearState).toBe("in_progress");
      expect(linear.state()).toBe("In Progress");

      // harness自身が起こした遷移は承認の変更ではない。checkpoint送信直前の
      // 再調停も、同じ承認指紋のまま先へ進める。
      expect(await startedWorkers[0]!.reconcileApproval()).toEqual({
        status: "current",
        approvalFingerprint: fingerprintOf("WHAT title"),
      });
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("the reconciliation after start still reports drift for any other state and stays unknown when the read fails", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts();
    let stateName = "Todo";
    let readable = true;
    const shifting: ImplementationApprovalPorts = {
      ...ports,
      readLinearIssue: async (issueId) => {
        const read = await ports.readLinearIssue(issueId);

        return read === null || !readable ? null : { ...read, stateName };
      },
    };
    const startedWorkers: StartImplementationWorkerOptions[] = [];
    const started = await startImplementationJob(
      options(databasePath, relay.origin, shifting, startedWorkers),
    );

    try {
      expect(started.status).toBe("started");

      // In Progressでも承認済みTodoでもないstateは、確定した承認の変更として扱う。
      for (const changed of ["Triage", "Done", "Cancelled"]) {
        stateName = changed;

        expect(await startedWorkers[0]!.reconcileApproval()).toEqual({
          status: "changed",
        });
      }

      // 読めなかっただけの提供元障害を、承認の変更と偽って主張しない。
      readable = false;

      expect(await startedWorkers[0]!.reconcileApproval()).toEqual({
        status: "unknown",
      });
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("a return to Triage that stays Todo is reported instead of being resent", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const linear = fakeLinearState({ movable: false });
    const { ports } = fakePorts({
      githubTitleByRead: (read) => (read === 3 ? "changed" : "WHAT title"),
    });

    try {
      expect(
        await startImplementationJob(
          options(databasePath, relay.origin, ports, [], linear.ports),
        ),
      ).toEqual({
        status: "refused",
        reason: "approval_changed",
        returnedToTriage: "still_todo",
      });
      // 自動再送はしない。attemptは一度だけ送る。
      expect(linear.moves).toEqual([linearIssueId]);
    } finally {
      relay.stop();
    }
  });
});

test("a worker that refuses to start releases the ownership and starts nothing", async () => {
  await withWorkspace(async (databasePath) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const { ports } = fakePorts();

    try {
      expect(
        await startImplementationJob({
          ...options(databasePath, relay.origin, ports),
          startWorker: async () => ({
            status: "refused" as const,
            reason: "target_base_not_integrated" as const,
          }),
        }),
      ).toEqual({
        status: "refused",
        reason: "target_base_not_integrated",
      });

      await Bun.sleep(50);

      expect(relay.openConnections()).toBe(0);
    } finally {
      relay.stop();
    }
  });
});
