import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { identity } from "@mikan-919/oriel-identity";
import type { PrResponseTrigger } from "@mikan-919/oriel-contracts";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import type { CheckpointBinding } from "./checkpoint-push";
import { runGit } from "./git";
import { createPiModelStreamProvider } from "./pi-model-provider";
import {
  startPrResponseWorker,
  type StartPrResponseWorkerOptions,
  type StartPrResponseWorkerResult,
} from "./pr-response-worker";

/** 実際のsystem Git、harness process、Agent loopを動かすため5秒では足りない。 */
const gitTestTimeoutMs = 120_000;

const digest = "a".repeat(64);
const canonicalBranch = `${identity.codeName}/ENG-12-gh-28-${digest}`;
const jobId = `pr-response:11:28:${digest}`;
const prNumber = 42;
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

const trigger: PrResponseTrigger = {
  kind: "review",
  body: "greeting.txt is missing a newline",
  comments: [{ path: "greeting.txt", line: 1, body: "add a newline" }],
};

const author = ["-c", "user.email=t@t", "-c", "user.name=t"];

async function git(cwd: string, ...args: string[]) {
  const result = await runGit(args, { cwd });

  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

interface RepositoryContext {
  directory: string;
  databasePath: string;
  repositoryRoot: string;
  worktreesRoot: string;
  remote: string;
  canonicalOid: string;
}

/**
 * 既に開いているPull Requestを模したbare remoteと、`serve`側のclone。
 * PR対応Jobはブランチを封印し直さず、この現在の先端からだけ始める。
 */
async function withOpenPullRequest<T>(
  run: (context: RepositoryContext) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-pr-response-e2e-"));
  const remote = join(directory, "remote.git");
  const seed = join(directory, "seed");
  const repositoryRoot = join(directory, "clone");

  try {
    await git(directory, "init", "--bare", "--initial-branch=main", remote);
    await git(directory, "clone", "--quiet", remote, seed);
    await writeFile(join(seed, "greeting.txt"), "hello");
    await git(seed, ...author, "add", "-A");
    await git(seed, ...author, "commit", "--quiet", "-m", "open the PR");
    await git(seed, "push", "--quiet", "origin", `HEAD:${canonicalBranch}`);
    await git(seed, "push", "--quiet", "origin", "HEAD:main");
    await git(directory, "clone", "--quiet", remote, repositoryRoot);

    return await run({
      directory,
      databasePath: join(directory, "serve.sqlite"),
      repositoryRoot,
      worktreesRoot: join(directory, "worktrees"),
      remote,
      canonicalOid: await git(seed, "rev-parse", "HEAD"),
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function ownership(
  current = true,
  stopSignal?: AbortSignal,
): StartPrResponseWorkerOptions["ownership"] {
  return {
    hasCurrentJobOwnership: () => current,
    hasCurrentBranchExclusivity: () => current,
    stopSignal,
  };
}

/**
 * 提供元だけを差し替えたmodel stream。credentialと接続先は`serve`の内側に
 * 留まり、harnessへは渡らない。
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
    resolveApiKey: async () => "provider-credential",
  });
}

/** triggerを読んでworktree内のsourceを実際に直して止まるAgent。 */
function respondingModel(path: string, content: string) {
  return fauxModelProvider([
    fauxAssistantMessage([fauxToolCall("write_file", { path, content })]),
    fauxAssistantMessage(fauxText(`${path} now addresses the review`)),
  ]);
}

function workerOptions(
  context: RepositoryContext,
  overrides: Partial<StartPrResponseWorkerOptions> = {},
): StartPrResponseWorkerOptions {
  return {
    databasePath: context.databasePath,
    repositoryRoot: context.repositoryRoot,
    worktreesRoot: context.worktreesRoot,
    remote: context.remote,
    harnessEntry,
    ownership: ownership(),
    binding,
    start: {
      type: "pr_response.start",
      jobId,
      jobLeaseId: binding.jobLeaseId,
      branchLeaseId: binding.branchLeaseId,
      approvalFingerprint: digest,
      canonicalBranch,
      canonicalOid: context.canonicalOid,
      prNumber,
      model: { provider: "lm-studio", id: "local-model" },
      trigger,
      // worktree内でbuild/testに相当するcommandを実際に走らせる。
      verification: [["git", "--version"]],
    },
    modelProvider: respondingModel("greeting.txt", "hello\n"),
    reconcileApproval: async () => ({
      status: "current",
      approvalFingerprint: digest,
    }),
    resolveCredential: async () => ({
      username: "x-access-token",
      token: "installation",
    }),
    release: () => {},
    ...overrides,
  };
}

function started(worker: StartPrResponseWorkerResult) {
  if (worker.status !== "started") {
    throw new Error(`the worker refused to start: ${worker.reason}`);
  }

  return worker;
}

function remoteTip(context: RepositoryContext) {
  return git(
    context.repositoryRoot,
    "ls-remote",
    context.remote,
    `refs/heads/${canonicalBranch}`,
  );
}

/**
 * checkpointまでの往復を必ず成功させたうえで、指定の終了コードで終わるharness。
 * 実harnessは拒否されたcheckpointでしか非0で終われないため、終了コードだけを
 * 切り離して確かめるにはこれが要る。
 */
async function writeFakeHarness(context: RepositoryContext, exitCode: number) {
  const path = join(context.directory, `harness-exit-${exitCode}.ts`);

  await writeFile(
    path,
    `const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";

async function read() {
  while (true) {
    const index = buffer.indexOf("\\n");

    if (index >= 0) {
      const line = buffer.slice(0, index);

      buffer = buffer.slice(index + 1);

      if (line !== "") {
        return JSON.parse(line);
      }

      continue;
    }

    const { done, value } = await reader.read();

    if (done) {
      throw new Error("stdin closed");
    }

    buffer += decoder.decode(value, { stream: true });
  }
}

function write(message) {
  return Bun.write(Bun.stdout, JSON.stringify(message) + "\\n");
}

function run(args) {
  const result = Bun.spawnSync(["git", ...args], { cwd: start.worktreePath });

  if (result.exitCode !== 0) {
    throw new Error("git " + args.join(" ") + " failed");
  }

  return new TextDecoder().decode(result.stdout).trim();
}

const start = await read();

await Bun.write(start.worktreePath + "/greeting.txt", "hello\\n");
run(["add", "-A"]);
run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "checkpoint"]);

await write({
  type: "checkpoint.request",
  requestId: "checkpoint-1",
  jobId: start.jobId,
  jobLeaseId: start.jobLeaseId,
  branchLeaseId: start.branchLeaseId,
  approvalFingerprint: start.approvalFingerprint,
  canonicalBranch: start.canonicalBranch,
  expectedOid: start.canonicalOid,
  headOid: run(["rev-parse", "HEAD"]),
  verified: true,
});

const accepted = await read();
const completed = await read();

if (accepted.type !== "checkpoint.accepted" || completed.type !== "checkpoint.completed") {
  throw new Error("the checkpoint did not complete: " + JSON.stringify(completed));
}

await write({
  type: "pr_response.result",
  jobId: start.jobId,
  jobLeaseId: start.jobLeaseId,
  stopReason: "stop",
  acted: true,
  sourceChanged: true,
  verified: true,
});

process.exit(${exitCode});
`,
  );

  return path;
}

test(
  "the Agent addresses the review in the open branch, and the checkpoint reaches the remote",
  async () => {
    await withOpenPullRequest(async (context) => {
      const released: boolean[] = [];
      const worker = started(
        await startPrResponseWorker(
          workerOptions(context, { release: () => released.push(true) }),
        ),
      );

      try {
        await worker.finished;

        // Agent loopがtriggerからworktree内のsourceを実際に変えている。
        expect(
          await Bun.file(join(worker.worktreePath, "greeting.txt")).text(),
        ).toBe("hello\n");

        // `serve`が遠隔のcanonicalブランチを進めた。
        const tip = (await remoteTip(context)).split("\t")[0];

        expect(tip).not.toBe(context.canonicalOid);
        expect(await git(worker.worktreePath, "rev-parse", "HEAD")).toBe(tip);

        // 全検証を通した完了checkpointは、最終差分にHANDOFFを残さない。
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
  "a Job that lost its ownership pushes nothing and does not complete",
  async () => {
    await withOpenPullRequest(async (context) => {
      const worker = started(
        await startPrResponseWorker(
          // 所有権を失った`serve`は、新しい外部操作を一切通さない。
          workerOptions(context, { ownership: ownership(false) }),
        ),
      );

      try {
        await worker.finished;

        // ローカルのcommitは残るが、遠隔のcanonicalブランチは動かない。
        expect(await remoteTip(context)).toContain(context.canonicalOid);
        expect(worker.jobStatus()).toBe("interrupted");
      } finally {
        await worker.close();
      }

      // 送れなかった作業途中成果を持つsandboxは、完了扱いで消さない。
      expect(
        await Bun.file(join(worker.worktreePath, "HANDOFF.md")).exists(),
      ).toBe(true);
    });
  },
  gitTestTimeoutMs,
);

test(
  "an ownership connection lost mid-run stops the worker without moving the remote",
  async () => {
    await withOpenPullRequest(async (context) => {
      const stopped = new AbortController();
      const worker = started(
        await startPrResponseWorker(
          workerOptions(context, {
            ownership: ownership(true, stopped.signal),
          }),
        ),
      );

      try {
        expect(worker.jobStatus()).toBe("running");

        // ADR 0004/0005: 接続所有権を失った時点でharnessごと止める。
        stopped.abort();

        await worker.finished;

        expect(worker.jobStatus()).toBe("interrupted");
        expect(await remoteTip(context)).toContain(context.canonicalOid);
      } finally {
        await worker.close();
      }
    });
  },
  gitTestTimeoutMs,
);

test(
  "ownership already lost before the worker starts still lets it finish",
  async () => {
    await withOpenPullRequest(async (context) => {
      const stopped = new AbortController();

      stopped.abort();

      const worker = started(
        await startPrResponseWorker(
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
        expect(await remoteTip(context)).toContain(context.canonicalOid);
      } finally {
        await worker.close();
      }
    });
  },
  gitTestTimeoutMs,
);

test(
  "a harness that exits abnormally after a completed checkpoint is not treated as done",
  async () => {
    // 一度成功したcheckpointは遠隔の先端を動かすため、実行ごとに開き直す。
    const run = (exitCode: number) =>
      withOpenPullRequest(async (context) => {
        const worker = started(
          await startPrResponseWorker(
            workerOptions(context, {
              harnessEntry: await writeFakeHarness(context, exitCode),
            }),
          ),
        );

        try {
          await worker.finished;

          return worker.jobStatus();
        } finally {
          await worker.close();
        }
      });

    // 同じ往復でも、harnessが異常終了した実行は完了と扱わない。
    expect(await run(0)).toBe("completed");
    expect(await run(9)).toBe("interrupted");
  },
  gitTestTimeoutMs,
);
