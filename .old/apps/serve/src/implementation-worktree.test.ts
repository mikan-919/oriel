import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import type { CheckpointBinding } from "./checkpoint-push";
import { runGit } from "./git";
import {
  startImplementationWorker,
  type StartImplementationWorkerOptions,
  type StartImplementationWorkerResult,
} from "./implementation-worker";
import { createPiModelStreamProvider } from "./pi-model-provider";

/** 実際のsystem Git、harness process、Agent loopを動かすため5秒では足りない。 */
const gitTestTimeoutMs = 120_000;

const digest = "a".repeat(64);
const canonicalBranch = `oriel/ENG-12-gh-28-${digest}`;
const jobId = `implementation:11:28:${digest}`;
const harnessEntry = new URL("../../harness/src/main.ts", import.meta.url)
  .pathname;

const binding: CheckpointBinding = {
  jobId,
  jobLeaseId: "job-lease-1",
  branchLeaseId: "branch-lease-1",
  branchKey: `11/${canonicalBranch}`,
  approvalFingerprint: digest,
  canonicalBranch,
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
};

const author = ["-c", "user.email=t@t", "-c", "user.name=t"];

async function git(cwd: string, ...args: string[]) {
  const result = await runGit(args, { cwd });

  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/** canonicalブランチを封印済みとして持つbare remoteと、`serve`側のcloneを作る。 */
async function withSealedRepository<T>(
  run: (context: {
    databasePath: string;
    repositoryRoot: string;
    worktreesRoot: string;
    remote: string;
    canonicalOid: string;
    /** 取り込み先branchを一つ進め、その新しいOIDを返す。 */
    advanceTargetBase: () => Promise<string>;
  }) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-implementation-e2e-"));
  const remote = join(directory, "remote.git");
  const seed = join(directory, "seed");
  const repositoryRoot = join(directory, "clone");

  try {
    await git(directory, "init", "--bare", "--initial-branch=main", remote);
    await git(directory, "clone", "--quiet", remote, seed);
    await writeFile(join(seed, "README.md"), "seed\n");
    await git(seed, ...author, "add", "-A");
    await git(seed, ...author, "commit", "--quiet", "-m", "seed");
    await git(seed, "push", "--quiet", "origin", `HEAD:${canonicalBranch}`);
    await git(seed, "push", "--quiet", "origin", "HEAD:main");
    await git(directory, "clone", "--quiet", remote, repositoryRoot);

    return await run({
      databasePath: join(directory, "serve.sqlite"),
      repositoryRoot,
      worktreesRoot: join(directory, "worktrees"),
      remote,
      canonicalOid: await git(seed, "rev-parse", "HEAD"),
      advanceTargetBase: async () => {
        // canonicalブランチと衝突しないfileだけを進める。
        await writeFile(join(seed, "TARGET_BASE.md"), "advanced\n");
        await git(seed, ...author, "add", "-A");
        await git(seed, ...author, "commit", "--quiet", "-m", "advance base");
        await git(seed, "push", "--quiet", "origin", "HEAD:main");

        return git(seed, "rev-parse", "HEAD");
      },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function ownership(current = true, stopSignal?: AbortSignal) {
  return {
    hasCurrentJobOwnership: () => current,
    hasCurrentBranchExclusivity: () => current,
    stopSignal,
  };
}

/**
 * 提供元だけを差し替えたmodel stream。
 *
 * `serve`はcredentialと接続先を持ったままpi-aiのeventを運び、harnessのAgent loop
 * はそれを別形式へ変換せずに受け取る。
 */
function fauxModelProvider(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
) {
  const faux = fauxProvider({
    provider: "lm-studio",
    models: [{ id: "local-model" }],
  });
  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses(responses);

  return createPiModelStreamProvider({
    models,
    // credentialは`serve`の内側だけで解決し、harnessへは渡さない。
    resolveApiKey: async () => "provider-credential",
  });
}

/** WHAT/HOWからworktree内のsourceを実際に編集して止まるAgent。 */
function implementingModel(path: string, content: string) {
  return fauxModelProvider([
    fauxAssistantMessage([fauxToolCall("write_file", { path, content })]),
    fauxAssistantMessage(fauxText(`${path} now exists`)),
  ]);
}

function workerOptions(
  context: Awaited<Parameters<Parameters<typeof withSealedRepository>[0]>[0]>,
  overrides: Partial<StartImplementationWorkerOptions> = {},
): StartImplementationWorkerOptions {
  return {
    databasePath: context.databasePath,
    repositoryRoot: context.repositoryRoot,
    worktreesRoot: context.worktreesRoot,
    remote: context.remote,
    harnessEntry,
    ownership: ownership(),
    binding,
    start: {
      type: "implementation.start",
      jobId,
      jobLeaseId: binding.jobLeaseId,
      branchLeaseId: binding.branchLeaseId,
      approvalFingerprint: digest,
      canonicalBranch,
      canonicalOid: context.canonicalOid,
      adopted: false,
      model: { provider: "lm-studio", id: "local-model" },
      what: { title: "WHAT title", body: "WHAT body" },
      how: {
        title: "Write greeting.txt",
        description: "Create greeting.txt with a greeting.",
      },
      // worktree内でbuild/testに相当するcommandを実際に走らせる。
      verification: [["git", "--version"]],
    },
    targetBase: { ref: "refs/heads/main", oid: context.canonicalOid },
    modelProvider: implementingModel("greeting.txt", "hello\n"),
    reconcileApproval: async () => ({
      status: "current",
      approvalFingerprint: digest,
    }),
    onApprovalChanged: async () => {},
    resolveCredential: async () => ({
      username: "x-access-token",
      token: "installation",
    }),
    release: () => {},
    ...overrides,
  };
}

function started(worker: StartImplementationWorkerResult) {
  if (worker.status !== "started") {
    throw new Error(`the worker refused to start: ${worker.reason}`);
  }

  return worker;
}

test(
  "the Agent edits the sealed worktree, and the harness verifies, commits and checkpoints it",
  async () => {
    await withSealedRepository(async (context) => {
      const released: boolean[] = [];
      const worker = started(
        await startImplementationWorker(
          workerOptions(context, { release: () => released.push(true) }),
        ),
      );

      try {
        await worker.finished;

        // Agent loopが承認済みHOWからworktree内のsourceを実際に変えている。
        expect(
          await Bun.file(join(worker.worktreePath, "greeting.txt")).text(),
        ).toBe("hello\n");

        // harnessが封印済み先端の上でcommitし、`serve`が遠隔へ送った。
        const remoteTip = (
          await git(
            context.repositoryRoot,
            "ls-remote",
            context.remote,
            `refs/heads/${canonicalBranch}`,
          )
        ).split("\t")[0];

        expect(remoteTip).not.toBe(context.canonicalOid);
        expect(await git(worker.worktreePath, "rev-parse", "HEAD")).toBe(
          remoteTip,
        );

        // 全検証を通した完了checkpointは、最終差分からHANDOFFを消している。
        const files = await git(
          worker.worktreePath,
          "show",
          "--name-only",
          "--format=",
          "HEAD",
        );

        expect(files).not.toContain("HANDOFF.md");
        expect(files).toContain("greeting.txt");
        expect(
          await Bun.file(join(worker.worktreePath, "HANDOFF.md")).exists(),
        ).toBe(false);
        expect(worker.jobStatus()).toBe("completed");
      } finally {
        await worker.close();
      }

      expect(released).toEqual([true]);
    });
  },
  gitTestTimeoutMs,
);

test(
  "an adopted branch integrates the advanced target base before the Agent runs",
  async () => {
    await withSealedRepository(async (context) => {
      const advanced = await context.advanceTargetBase();
      const worker = started(
        await startImplementationWorker(
          workerOptions(context, {
            start: {
              ...workerOptions(context).start,
              adopted: true,
            },
            targetBase: { ref: "refs/heads/main", oid: advanced },
          }),
        ),
      );

      try {
        // 統合した先端から始まるため、封印時のOIDより進んでいる。
        expect(worker.worktreeOid).not.toBe(context.canonicalOid);
        expect(
          await git(
            worker.worktreePath,
            "merge-base",
            "--is-ancestor",
            advanced,
            "HEAD",
          ),
        ).toBe("");

        await worker.finished;

        // 取り込み先の内容も、Agentの編集も、同じcheckpointの上に載っている。
        expect(
          await Bun.file(join(worker.worktreePath, "TARGET_BASE.md")).text(),
        ).toBe("advanced\n");
        expect(
          await Bun.file(join(worker.worktreePath, "greeting.txt")).text(),
        ).toBe("hello\n");
        expect(worker.jobStatus()).toBe("completed");
      } finally {
        await worker.close();
      }
    });
  },
  gitTestTimeoutMs,
);

test(
  "a target base that cannot be integrated starts no worker and keeps the approval",
  async () => {
    await withSealedRepository(async (context) => {
      const worker = await startImplementationWorker(
        workerOptions(context, {
          start: { ...workerOptions(context).start, adopted: true },
          // 承認の読み直しで確認したOIDが遠隔に存在しない。
          targetBase: { ref: "refs/heads/main", oid: "9".repeat(40) },
        }),
      );

      expect(worker).toEqual({
        status: "refused",
        reason: "target_base_not_integrated",
      });
    });
  },
  gitTestTimeoutMs,
);

test(
  "an approval that changed during the integration starts no worker",
  async () => {
    await withSealedRepository(async (context) => {
      const advanced = await context.advanceTargetBase();

      expect(
        await startImplementationWorker(
          workerOptions(context, {
            start: { ...workerOptions(context).start, adopted: true },
            targetBase: { ref: "refs/heads/main", oid: advanced },
            reconcileApproval: async () => ({ status: "changed" }),
          }),
        ),
      ).toEqual({ status: "refused", reason: "approval_changed" });

      // 読めなかっただけの提供元障害は、承認の変更と別に扱う。
      expect(
        await startImplementationWorker(
          workerOptions(context, {
            start: { ...workerOptions(context).start, adopted: true },
            targetBase: { ref: "refs/heads/main", oid: advanced },
            reconcileApproval: async () => ({ status: "unknown" }),
          }),
        ),
      ).toEqual({ status: "refused", reason: "approval_state_unknown" });

      expect(
        await startImplementationWorker(
          workerOptions(context, {
            start: { ...workerOptions(context).start, adopted: true },
            targetBase: { ref: "refs/heads/main", oid: advanced },
            ownership: ownership(false),
          }),
        ),
      ).toEqual({ status: "refused", reason: "ownership_not_current" });
    });
  },
  gitTestTimeoutMs,
);

test(
  "an Agent that changed no source leaves the Job interrupted and keeps the sandbox",
  async () => {
    await withSealedRepository(async (context) => {
      const worker = started(
        await startImplementationWorker(
          workerOptions(context, {
            // 何も編集せずに止まったAgent loop。
            modelProvider: fauxModelProvider([
              fauxAssistantMessage(fauxText("I cannot reach the source")),
            ]),
          }),
        ),
      );

      try {
        await worker.finished;

        // HANDOFFだけのWIP checkpointは送れても、実装完了とは扱わない。
        expect(worker.jobStatus()).toBe("interrupted");
      } finally {
        await worker.close();
      }

      // 完了していないJobのsandboxは、cleanでも成功として消さない。
      expect(
        await Bun.file(join(worker.worktreePath, "HANDOFF.md")).exists(),
      ).toBe(true);
    });
  },
  gitTestTimeoutMs,
);

test(
  "an approval that changed before the checkpoint is returned from Todo to Triage",
  async () => {
    await withSealedRepository(async (context) => {
      const returned: string[] = [];
      const worker = started(
        await startImplementationWorker(
          workerOptions(context, {
            // 送信直前の再調停で、承認対象が変わったと確定した場合。
            reconcileApproval: async () => ({ status: "changed" }),
            onApprovalChanged: async () => {
              returned.push("return-to-triage");
            },
          }),
        ),
      );

      try {
        await worker.finished;

        expect(returned).toEqual(["return-to-triage"]);
        expect(worker.jobStatus()).toBe("interrupted");
        // 承認対象が変わったJobは、遠隔のcanonicalブランチを動かさない。
        expect(
          await git(
            context.repositoryRoot,
            "ls-remote",
            context.remote,
            `refs/heads/${canonicalBranch}`,
          ),
        ).toContain(context.canonicalOid);
      } finally {
        await worker.close();
      }
    });
  },
  gitTestTimeoutMs,
);

test(
  "an approval that cannot be read before the checkpoint is not returned to Triage",
  async () => {
    await withSealedRepository(async (context) => {
      const returned: string[] = [];
      const worker = started(
        await startImplementationWorker(
          workerOptions(context, {
            reconcileApproval: async () => ({ status: "unknown" }),
            onApprovalChanged: async () => {
              returned.push("return-to-triage");
            },
          }),
        ),
      );

      try {
        await worker.finished;

        // 単なる提供元障害で承認を差し戻さない。再読で収束させる。
        expect(returned).toEqual([]);
        expect(worker.jobStatus()).toBe("interrupted");
      } finally {
        await worker.close();
      }
    });
  },
  gitTestTimeoutMs,
);

test(
  "a refused checkpoint keeps the work in progress instead of completing the Job",
  async () => {
    await withSealedRepository(async (context) => {
      const worker = started(
        await startImplementationWorker(
          workerOptions(context, {
            // 所有権を失った`serve`は新しい外部操作を通さない。
            ownership: ownership(false),
          }),
        ),
      );

      try {
        await worker.finished;

        // ローカルのcommitは残るが、遠隔のcanonicalブランチは動かない。
        expect(
          await git(
            context.repositoryRoot,
            "ls-remote",
            context.remote,
            `refs/heads/${canonicalBranch}`,
          ),
        ).toContain(context.canonicalOid);
        // 送れなかったJobを`completed`にしない。
        expect(worker.jobStatus()).toBe("interrupted");
      } finally {
        await worker.close();
      }

      // 復元できない作業途中成果を持つsandboxは消さない。
      expect(
        await Bun.file(join(worker.worktreePath, "HANDOFF.md")).exists(),
      ).toBe(true);
    });
  },
  gitTestTimeoutMs,
);

test(
  "ownership already lost before the worker starts still lets it finish",
  async () => {
    await withSealedRepository(async (context) => {
      const stopped = new AbortController();

      stopped.abort();

      const worker = started(
        await startImplementationWorker(
          workerOptions(context, {
            ownership: ownership(true, stopped.signal),
          }),
        ),
      );

      try {
        // 開始前に既に失効した所有権でも、spawnしたharnessが誰にも
        // 止められず`finished`が永久に解決しないことがあってはならない。
        await worker.finished;

        expect(worker.jobStatus()).toBe("interrupted");
      } finally {
        await worker.close();
      }
    });
  },
  gitTestTimeoutMs,
);

test(
  "a tip that no longer matches the sealed OID starts no worker at all",
  async () => {
    await withSealedRepository(async (context) => {
      expect(
        await startImplementationWorker(
          workerOptions(context, {
            start: {
              ...workerOptions(context).start,
              canonicalOid: "9".repeat(40),
            },
            resolveCredential: async () => null,
          }),
        ),
      ).toEqual({
        status: "refused",
        reason: "canonical_worktree_unavailable",
      });
    });
  },
  gitTestTimeoutMs,
);
