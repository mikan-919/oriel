import { expect, test } from "bun:test";

import type {
  ImplementationClientMessage,
  ImplementationStartEvent,
} from "@mikan-919/oriel-contracts";

import type { ImplementationAgent, ImplementationAgentOutcome } from "./agent";
import type { LocalGit } from "./git";
import { runImplementationWorker } from "./implementation";

const digest = "a".repeat(64);
const sealedOid = "1".repeat(40);
const checkpointOid = "2".repeat(40);

function startEvent(
  overrides: Partial<ImplementationStartEvent> = {},
): ImplementationStartEvent {
  return {
    type: "implementation.start",
    jobId: `implementation:11:28:${digest}`,
    jobLeaseId: "job-lease-1",
    branchLeaseId: "branch-lease-1",
    approvalFingerprint: digest,
    canonicalBranch: `oriel/ENG-12-gh-28-${digest}`,
    canonicalOid: sealedOid,
    worktreePath: "/worktrees/job",
    worktreeOid: sealedOid,
    adopted: false,
    model: { provider: "lm-studio", id: "local-model" },
    what: { title: "WHAT title", body: "WHAT body" },
    how: { title: "HOW title", description: "HOW description" },
    verification: [["bun", "run", "typecheck"]],
    ...overrides,
  };
}

/** worktree内のsourceを編集するAgent loopを模す。 */
function fakeAgent(
  outcome: Partial<ImplementationAgentOutcome> = {},
): ImplementationAgent {
  return {
    run: async () => ({
      turns: 2,
      toolCalls: 1,
      stopReason: "stop",
      acted: true,
      ...outcome,
    }),
    abort: () => {},
  };
}

/**
 * worktree内のGitを模す。commitで先端が動き、それ以外は成功として答える。
 *
 * `sourceDirty`はAgent loopの直後、`dirty`はHANDOFFを書いた後の作業ツリーを表す。
 */
function fakeGit(
  options: {
    headOids?: string[];
    dirty?: boolean;
    sourceDirty?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const heads = options.headOids ?? [sealedOid, checkpointOid];
  let revParses = 0;
  let statuses = 0;
  const git: LocalGit = {
    async run(args) {
      calls.push(args);

      if (args[0] === "rev-parse") {
        const head = heads[Math.min(revParses, heads.length - 1)]!;
        revParses += 1;
        return { ok: true, stdout: `${head}\n`, stderr: "" };
      }

      if (args[0] === "status") {
        statuses += 1;

        // 一度目はAgentの編集の有無、二度目以降はcommitできる差分の有無。
        const dirty =
          statuses === 1
            ? (options.sourceDirty ?? true)
            : options.dirty !== false;

        return {
          ok: true,
          stdout: dirty ? " M source.ts\n" : "",
          stderr: "",
        };
      }

      return { ok: true, stdout: "", stderr: "" };
    },
  };

  return { git, calls };
}

function fakeTransport(answers: unknown[]) {
  const written: ImplementationClientMessage[] = [];
  const queue = [...answers];

  return {
    written,
    transport: {
      write(message: ImplementationClientMessage) {
        written.push(message);
      },
      read: () => Promise.resolve(queue.shift()),
    },
  };
}

function acceptedThenCompleted(requestId = "checkpoint-1") {
  return [
    { type: "checkpoint.accepted", requestId, operationId: "operation-1" },
    {
      type: "checkpoint.completed",
      requestId,
      operationId: "operation-1",
      canonicalOid: checkpointOid,
    },
  ];
}

test("the worker verifies, commits and checkpoints inside the sealed worktree", async () => {
  const { git, calls } = fakeGit();
  const { transport, written } = fakeTransport(acceptedThenCompleted());
  const commands: { command: string[]; cwd: string }[] = [];
  const files = new Map<string, string>();
  const start = startEvent();

  const outcome = await runImplementationWorker({
    start,
    transport,
    git,
    agent: fakeAgent(),
    runCommand: async (command, cwd) => {
      commands.push({ command, cwd });
      return { ok: true, output: "" };
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  });

  // build/testは承認済みworktreeの中だけで動く。
  expect(commands).toEqual([
    { command: ["bun", "run", "typecheck"], cwd: "/worktrees/job" },
  ]);
  expect(outcome.verified).toBe(true);
  expect(outcome.checkpoint).toBe("completed");
  expect(outcome.headOid).toBe(checkpointOid);

  // 全検証を通した完了checkpointは、最終差分からHANDOFFを消す。
  expect(files.has("/worktrees/job/HANDOFF.md")).toBe(false);
  expect(calls).toContainEqual(["rm", "--ignore-unmatch", "-f", "HANDOFF.md"]);

  // commitは人間のGit設定を継承せず、固定の著者で行う。
  const commit = calls.find((args) => args.includes("commit")) ?? [];

  expect(commit).toContain("user.name=Oriel");
  expect(commit).toContain("user.email=oriel@oriel.invalid");

  // 送信前OIDを比較条件として渡し、credentialは一切載せない。
  expect(written).toEqual([
    {
      type: "checkpoint.request",
      requestId: "checkpoint-1",
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      branchLeaseId: start.branchLeaseId,
      approvalFingerprint: digest,
      canonicalBranch: start.canonicalBranch,
      expectedOid: sealedOid,
      headOid: checkpointOid,
      verified: true,
    },
    // 実装できたかどうかは、processの終了ではなく明示の結果で`serve`へ伝える。
    {
      type: "implementation.result",
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      stopReason: "stop",
      acted: true,
      sourceChanged: true,
      verified: true,
    },
  ]);
});

test("an Agent that stopped without editing the source says so in the result", async () => {
  // 停止理由がerrorで、tool実行もsourceの変更もない場合。
  const { git } = fakeGit({ sourceDirty: false });
  const { transport, written } = fakeTransport(acceptedThenCompleted());

  const outcome = await runImplementationWorker({
    start: startEvent(),
    transport,
    git,
    agent: fakeAgent({
      turns: 1,
      toolCalls: 0,
      stopReason: "error",
      acted: false,
    }),
    runCommand: async () => ({ ok: true, output: "" }),
    writeFile: async () => {},
  });

  expect(outcome.sourceChanged).toBe(false);
  // HANDOFFだけのWIP checkpointは残してよいが、実装完了とは言わない。
  expect(outcome.checkpoint).toBe("completed");
  expect(written.at(-1)).toEqual({
    type: "implementation.result",
    jobId: startEvent().jobId,
    jobLeaseId: startEvent().jobLeaseId,
    stopReason: "error",
    acted: false,
    sourceChanged: false,
    verified: true,
  });
});

test("a failing verification still checkpoints, marked as unverified work in progress", async () => {
  const { git } = fakeGit();
  const { transport, written } = fakeTransport(acceptedThenCompleted());
  const files = new Map<string, string>();

  const outcome = await runImplementationWorker({
    start: startEvent({
      verification: [
        ["bun", "run", "typecheck"],
        ["bun", "test"],
      ],
    }),
    transport,
    git,
    agent: fakeAgent(),
    runCommand: async (command) => ({
      ok: command[1] !== "test",
      output: "1 failing test",
    }),
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  });

  // 計画停止で検証を通せない場合も、失敗中の検証を明記したWIPを残す。
  expect(outcome.verified).toBe(false);
  expect(outcome.checkpoint).toBe("completed");
  expect(written[0]).toMatchObject({ verified: false });
  expect(files.get("/worktrees/job/HANDOFF.md")).toContain("bun test");
});

test("the worker refuses a worktree that is not at the sealed tip", async () => {
  const { git } = fakeGit({ headOids: ["9".repeat(40)] });
  const { transport, written } = fakeTransport([]);

  await expect(
    runImplementationWorker({
      start: startEvent(),
      transport,
      git,
      agent: fakeAgent(),
      runCommand: async () => ({ ok: true, output: "" }),
      writeFile: async () => {},
    }),
  ).rejects.toThrow();

  // 封印した先端でなければ、検証もcommitも外部操作も始めない。
  expect(written).toEqual([]);
});

test("a rejected checkpoint is reported rather than resent", async () => {
  const { git } = fakeGit();
  const { transport, written } = fakeTransport([
    {
      type: "checkpoint.rejected",
      requestId: "checkpoint-1",
      reason: "remote_diverged",
    },
  ]);

  const outcome = await runImplementationWorker({
    start: startEvent(),
    transport,
    git,
    agent: fakeAgent(),
    runCommand: async () => ({ ok: true, output: "" }),
    writeFile: async () => {},
  });

  expect(outcome.checkpoint).toBe("rejected");
  expect(outcome.checkpointRejection).toBe("remote_diverged");
  // 再送はせず、結果だけを`serve`へ伝える。
  expect(written.map((message) => message.type)).toEqual([
    "checkpoint.request",
    "implementation.result",
  ]);
});

test("a worktree with nothing to commit sends no checkpoint", async () => {
  const { git } = fakeGit({
    headOids: [sealedOid],
    dirty: false,
    sourceDirty: false,
  });
  const { transport, written } = fakeTransport([]);

  const outcome = await runImplementationWorker({
    start: startEvent({ verification: [] }),
    transport,
    git,
    agent: fakeAgent(),
    runCommand: async () => ({ ok: true, output: "" }),
    // HANDOFFの内容が現在の作業ツリーと同じで、差分が出ない場合。
    writeFile: async () => {},
  });

  expect(outcome.committed).toBe(false);
  expect(outcome.checkpoint).toBe("skipped");
  // checkpointは送らないが、実装できなかったことは`serve`へ伝える。
  expect(written).toEqual([
    {
      type: "implementation.result",
      jobId: startEvent().jobId,
      jobLeaseId: startEvent().jobLeaseId,
      stopReason: "stop",
      acted: true,
      sourceChanged: false,
      verified: false,
    },
  ]);
});
