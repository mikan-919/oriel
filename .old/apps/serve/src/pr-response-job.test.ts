import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { identity } from "@mikan-919/oriel-identity";
import type { PrResponseTrigger } from "@mikan-919/oriel-contracts";

import type { DeviceTokenStore } from "./device-registration";
import {
  createPrResponseCheckFailureStore,
  prResponseCheckFailureLimit,
} from "./pr-response-check-failures";
import {
  startPrResponseJob,
  type PrResponseExecutionConfigPorts,
  type StartPrResponseJobOptions,
  type StartPrResponseJobRefusal,
} from "./pr-response-job";
import type { StartPrResponseWorkerOptions } from "./pr-response-worker";
import { openServeLocalState } from "./local-state";
import { createRelayOwnershipConnection } from "./ownership-connection";
import { startFakeOwnershipRelay } from "./ownership-relay.fake";

const deviceToken = "7.11.device-token";
const repositoryId = 11;
const repository = { owner: "mikan-919", name: "oriel" };
const githubIssueNumber = 28;
const approvalFingerprint = "a".repeat(64);
const headRef = `${identity.codeName}/ENG-12-gh-${githubIssueNumber}-${approvalFingerprint}`;
const headOid = "1111111111111111111111111111111111111111";
const targetBaseOid = "2222222222222222222222222222222222222222";
const prNumber = 42;
const jobId = `pr-response:${repositoryId}:${githubIssueNumber}:${approvalFingerprint}`;
const harnessEntry = new URL("../../harness/src/main.ts", import.meta.url)
  .pathname;

const reviewTrigger: PrResponseTrigger = {
  kind: "review",
  body: "please fix the guard",
  comments: [{ path: "src/guard.ts", line: 12, body: "invert this" }],
};

const checkFailureTrigger: PrResponseTrigger = {
  kind: "check_failure",
  checkName: "typecheck",
  conclusion: "failure",
  summary: "2 errors",
};

/** 取り込み先branchに置かれた実行設定。PR対応Jobもここだけを正本にする。 */
const targetBaseConfig = `schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
  verification:
    - ["bun", "run", "typecheck"]
    - ["bun", "test"]
`;

function tokenStore(token: string | null): DeviceTokenStore {
  return { set: async () => {}, get: async () => token };
}

/** 取り込み先の現在値と実行設定を差し替えられるports。読み取りも記録する。 */
function fakeConfigPorts(
  options: {
    executionConfig?: string | "absent" | "unreadable";
    targetBase?: { ref: string; oid: string } | null;
  } = {},
) {
  const reads: { oid: string; path: string }[] = [];
  const ports: PrResponseExecutionConfigPorts = {
    readTargetBase: async () =>
      options.targetBase === undefined
        ? { ref: "refs/heads/main", oid: targetBaseOid }
        : options.targetBase,
    readTargetBaseFile: async (oid, path) => {
      reads.push({ oid, path });

      const configured = options.executionConfig ?? targetBaseConfig;

      if (configured === "absent") {
        return { status: "absent" };
      }

      return configured === "unreadable"
        ? { status: "unknown" }
        : { status: "present", content: configured };
    },
  };

  return { ports, reads };
}

/** 起動順序だけを確かめるworker。実際のworktreeは`pr-response-worktree.test.ts`が見る。 */
function fakeWorker(
  started: StartPrResponseWorkerOptions[],
  jobStatus: () => string | null = () => "running",
) {
  return async (workerOptions: StartPrResponseWorkerOptions) => {
    started.push(workerOptions);

    return {
      status: "started" as const,
      worktreePath: "/worktrees/job",
      finished: Promise.resolve(),
      jobStatus,
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

async function withWorkspace<T>(
  run: (context: {
    databasePath: string;
    checkFailures: ReturnType<typeof createPrResponseCheckFailureStore>;
  }) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-pr-response-"));
  const databasePath = join(directory, "serve.sqlite");
  const database = openServeLocalState(databasePath);

  try {
    return await run({
      databasePath,
      checkFailures: createPrResponseCheckFailureStore(database),
    });
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function options(
  context: {
    databasePath: string;
    checkFailures: ReturnType<typeof createPrResponseCheckFailureStore>;
  },
  relayOrigin: string,
  overrides: Partial<StartPrResponseJobOptions> = {},
): StartPrResponseJobOptions {
  return {
    relayOrigin,
    tokenStore: tokenStore(deviceToken),
    databasePath: context.databasePath,
    harnessEntry,
    repositoryId,
    repository,
    heartbeatStopMs: 500,
    repositoryRoot: "/repository",
    worktreesRoot: "/worktrees",
    remote: "origin",
    resolveCredential: async () => null,
    model: { provider: "lm-studio", id: "local-model" },
    modelProvider,
    getModelCapabilities: async () => null,
    createExecutionConfigPorts: async () => fakeConfigPorts().ports,
    createReconciliationPorts: async () => null,
    createReportPorts: async () => null,
    checkFailures: context.checkFailures,
    prNumber,
    headRef,
    headOid,
    githubIssueNumber,
    approvalFingerprint,
    trigger: reviewTrigger,
    startWorker: fakeWorker([]),
    ...overrides,
  };
}

/** 同じキーを先に押さえている別のworkerを模す。 */
async function rivalHolder(
  relayOrigin: string,
  holds: { jobId: string; branchKey?: string },
) {
  const rival = createRelayOwnershipConnection({
    relayOrigin,
    deviceToken,
    jobId: holds.jobId,
    heartbeatStopMs: 500,
  });
  const leaseId = await rival.acquireJobOwnership();

  if (holds.branchKey !== undefined) {
    await rival.acquireBranchExclusivity(holds.branchKey);
  }

  expect(leaseId).toEqual(expect.any(String));

  return rival;
}

test("an admitted trigger takes job ownership and branch exclusivity before starting a worker", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const config = fakeConfigPorts();
    const startedWorkers: StartPrResponseWorkerOptions[] = [];
    const started = await startPrResponseJob(
      options(context, relay.origin, {
        createExecutionConfigPorts: async () => config.ports,
        startWorker: fakeWorker(startedWorkers),
      }),
    );

    try {
      expect(started.status).toBe("started");

      if (started.status !== "started") {
        return;
      }

      // Job識別子はclientの申告ではなく、対象と承認指紋から導く。
      expect(started.jobId).toBe(jobId);
      // ADR 0002/0007: Jobとブランチの両方の接続を保持したままworkerを始める。
      expect(relay.openConnections()).toBe(2);
      // 実行設定は取り込み先branchの版だけを読む。
      expect(config.reads).toEqual([
        { oid: targetBaseOid, path: ".oriel.yaml" },
      ]);

      expect(startedWorkers).toHaveLength(1);
      expect(startedWorkers[0]!.start).toEqual({
        type: "pr_response.start",
        jobId,
        jobLeaseId: expect.any(String),
        branchLeaseId: expect.any(String),
        approvalFingerprint,
        // 既に開いているPull Requestのheadから始め、封印し直さない。
        canonicalBranch: headRef,
        canonicalOid: headOid,
        prNumber,
        model: { provider: "lm-studio", id: "local-model" },
        trigger: reviewTrigger,
        verification: [
          ["bun", "run", "typecheck"],
          ["bun", "test"],
        ],
      });
      // 実装Jobと同じキーを共有し、同じcanonicalブランチへの書き込みを直列化する。
      expect(startedWorkers[0]!.binding).toMatchObject({
        jobId,
        branchKey: `${repositoryId}/${headRef}`,
        approvalFingerprint,
        canonicalBranch: headRef,
        repository,
        issueNumber: githubIssueNumber,
      });
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("an unregistered device starts no worker and opens no ownership connection", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const startedWorkers: StartPrResponseWorkerOptions[] = [];

    try {
      expect(
        await startPrResponseJob(
          options(context, relay.origin, {
            tokenStore: tokenStore(null),
            startWorker: fakeWorker(startedWorkers),
          }),
        ),
      ).toEqual({ status: "refused", reason: "device_not_registered" });
      expect(relay.openConnections()).toBe(0);
      expect(startedWorkers).toHaveLength(0);
    } finally {
      relay.stop();
    }
  });
});

test("ownership already held elsewhere refuses without touching the target base", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const heldJob = await rivalHolder(relay.origin, { jobId });
    const config = fakeConfigPorts();
    const startedWorkers: StartPrResponseWorkerOptions[] = [];

    try {
      expect(
        await startPrResponseJob(
          options(context, relay.origin, {
            createExecutionConfigPorts: async () => config.ports,
            startWorker: fakeWorker(startedWorkers),
          }),
        ),
      ).toEqual({ status: "refused", reason: "job_ownership_not_acquired" });

      // 所有権を取れないJobは、実行設定すら読まない。
      expect(config.reads).toEqual([]);
      expect(startedWorkers).toHaveLength(0);
    } finally {
      heldJob.release();
      relay.stop();
    }
  });
});

test("a canonical branch already held by another worker refuses", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const heldBranch = await rivalHolder(relay.origin, {
      jobId: `implementation:${repositoryId}:${githubIssueNumber}:${approvalFingerprint}`,
      branchKey: `${repositoryId}/${headRef}`,
    });
    const startedWorkers: StartPrResponseWorkerOptions[] = [];

    try {
      expect(
        await startPrResponseJob(
          options(context, relay.origin, {
            startWorker: fakeWorker(startedWorkers),
          }),
        ),
      ).toEqual({ status: "refused", reason: "branch_not_exclusive" });
      expect(startedWorkers).toHaveLength(0);
    } finally {
      heldBranch.release();
      relay.stop();
    }
  });
});

test("an unreadable target base or execution config refuses and releases the ownership", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);

    const cases: {
      overrides: Partial<StartPrResponseJobOptions>;
      reason: StartPrResponseJobRefusal["reason"];
    }[] = [
      {
        overrides: { createExecutionConfigPorts: async () => null },
        reason: "execution_config_ports_unavailable",
      },
      {
        overrides: {
          createExecutionConfigPorts: async () =>
            fakeConfigPorts({ targetBase: null }).ports,
        },
        reason: "target_base_unavailable",
      },
      {
        overrides: {
          createExecutionConfigPorts: async () =>
            fakeConfigPorts({ executionConfig: "absent" }).ports,
        },
        reason: "execution_config_missing",
      },
      {
        overrides: {
          createExecutionConfigPorts: async () =>
            fakeConfigPorts({ executionConfig: "unreadable" }).ports,
        },
        reason: "execution_config_unreadable",
      },
      {
        overrides: {
          createExecutionConfigPorts: async () =>
            fakeConfigPorts({ executionConfig: "schemaVersion: 2\n" }).ports,
        },
        reason: "execution_config_invalid",
      },
    ];

    try {
      // 拒否のたびに所有権接続を手放すため、後続の試行が同じキーを取り直せる。
      // 手放せていなければ、二件目以降は`job_ownership_not_acquired`になる。
      for (const { overrides, reason } of cases) {
        expect(
          await startPrResponseJob(options(context, relay.origin, overrides)),
        ).toEqual({ status: "refused", reason });
      }
    } finally {
      relay.stop();
    }
  });
});

test("a model that does not satisfy the target base modelCapabilities refuses", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const requiresReasoning = `${targetBaseConfig}modelCapabilities:
  reasoning: true
`;
    const startedWorkers: StartPrResponseWorkerOptions[] = [];
    const withCapabilities = (
      metadata: {
        reasoning: boolean;
        input: readonly string[];
        contextWindow: number;
        maxTokens: number;
      } | null,
    ) =>
      startPrResponseJob(
        options(context, relay.origin, {
          createExecutionConfigPorts: async () =>
            fakeConfigPorts({ executionConfig: requiresReasoning }).ports,
          getModelCapabilities: async () => metadata,
          startWorker: fakeWorker(startedWorkers),
        }),
      );

    try {
      // ADR 0009: 照合できないmodelも、満たさないmodelと同じくfail closedにする。
      expect(await withCapabilities(null)).toEqual({
        status: "refused",
        reason: "model_capability_mismatch",
      });
      expect(
        await withCapabilities({
          reasoning: false,
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 32_000,
        }),
      ).toEqual({ status: "refused", reason: "model_capability_mismatch" });
      expect(startedWorkers).toHaveLength(0);

      const satisfied = await withCapabilities({
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 32_000,
      });

      expect(satisfied.status).toBe("started");
      expect(startedWorkers).toHaveLength(1);

      if (satisfied.status === "started") {
        await satisfied.close();
      }
    } finally {
      relay.stop();
    }
  });
});

test("the checkpoint reconciliation distinguishes a closed Pull Request from an unreadable one", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const startedWorkers: StartPrResponseWorkerOptions[] = [];
    let open: boolean | null = true;
    const started = await startPrResponseJob(
      options(context, relay.origin, {
        createReconciliationPorts: async () => ({
          isPullRequestOpenWithHead: async (input) => {
            expect(input).toEqual({ prNumber, headRef });

            if (open === null) {
              throw new Error("the Pull Request could not be read");
            }

            return open;
          },
        }),
        startWorker: fakeWorker(startedWorkers),
      }),
    );

    try {
      expect(started.status).toBe("started");

      const reconcile = startedWorkers[0]!.reconcileApproval;

      // 対象PRが開いたままheadも変わっていない: 承認は現在値のまま。
      expect(await reconcile()).toEqual({
        status: "current",
        approvalFingerprint,
      });

      open = false;
      expect(await reconcile()).toEqual({ status: "changed" });

      // 読めなかっただけの提供元障害を、対象の変更と混同しない。
      open = null;
      expect(await reconcile()).toEqual({ status: "unknown" });
    } finally {
      if (started.status === "started") {
        await started.close();
      }

      relay.stop();
    }
  });
});

test("a reconciliation boundary that cannot be built leaves the approval undecided", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const startedWorkers: StartPrResponseWorkerOptions[] = [];
    const started = await startPrResponseJob(
      options(context, relay.origin, {
        createReconciliationPorts: async () => null,
        startWorker: fakeWorker(startedWorkers),
      }),
    );

    try {
      expect(started.status).toBe("started");
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

/** review/commentのtriggerでは、収束しても収束しなくても目印のackを残す。 */
test("a review trigger always leaves an acknowledgement comment on the Pull Request", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const bodies: string[] = [];
    const run = async (status: string) => {
      const started = await startPrResponseJob(
        options(context, relay.origin, {
          createReportPorts: async () => ({
            createComment: async ({ prNumber: target, body }) => {
              expect(target).toBe(prNumber);
              bodies.push(body);

              return true;
            },
          }),
          startWorker: fakeWorker([], () => status),
        }),
      );

      if (started.status !== "started") {
        throw new Error(`the Job refused to start: ${started.reason}`);
      }

      await started.finished;
      await started.close();
    };

    try {
      await run("completed");
      await run("interrupted");

      expect(bodies).toEqual([
        "Pushed an update addressing the feedback above.",
        "Attempted to address the feedback above, but could not push a verified fix. A human needs to look at this.",
      ]);
      // 収束できたかに関わらず、check failureの回数はreview triggerで動かさない。
      expect(
        context.checkFailures.count(repositoryId, headRef, "typecheck"),
      ).toBe(0);
    } finally {
      relay.stop();
    }
  });
});

/** ADR 0007の収束上限: 解消できなかった試行だけを数え、上限で一度だけ報告する。 */
test("an unresolved check failure counts up to the limit and reports exactly once", async () => {
  await withWorkspace(async (context) => {
    const relay = startFakeOwnershipRelay(deviceToken);
    const bodies: string[] = [];
    const run = async (status: string) => {
      const started = await startPrResponseJob(
        options(context, relay.origin, {
          trigger: checkFailureTrigger,
          createReportPorts: async () => ({
            createComment: async ({ body }) => {
              bodies.push(body);

              return true;
            },
          }),
          startWorker: fakeWorker([], () => status),
        }),
      );

      if (started.status !== "started") {
        throw new Error(`the Job refused to start: ${started.reason}`);
      }

      await started.finished;
      await started.close();
    };

    try {
      // 解消できたJobは回数も報告も動かさない。
      await run("completed");
      expect(
        context.checkFailures.count(repositoryId, headRef, "typecheck"),
      ).toBe(0);
      expect(bodies).toEqual([]);

      for (
        let attempt = 1;
        attempt <= prResponseCheckFailureLimit;
        attempt += 1
      ) {
        await run("interrupted");
        expect(
          context.checkFailures.count(repositoryId, headRef, "typecheck"),
        ).toBe(attempt);
        // 上限へ達するまでは、人へ知らせずに次のtriggerを待つ。
        expect(bodies).toHaveLength(
          attempt < prResponseCheckFailureLimit ? 0 : 1,
        );
      }

      expect(bodies[0]).toBe(
        `Stopped automatic fixes for the \`typecheck\` check after ${prResponseCheckFailureLimit} failed attempts. A human needs to look at this.`,
      );
    } finally {
      relay.stop();
    }
  });
});
