import { writeFile as writeFileToDisk } from "node:fs/promises";
import { join } from "node:path";

import {
  parseCheckpointEvent,
  type CheckpointRequest,
  type PrResponseClientMessage,
  type PrResponseStartEvent,
} from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";

import type { LocalGit } from "./git";
import type {
  PrResponseAgent,
  PrResponseAgentOutcome,
} from "./pr-response-agent";

export interface PrResponseTransport {
  write(message: PrResponseClientMessage): void | Promise<void>;
  read(): Promise<unknown>;
}

export interface VerificationRun {
  command: string[];
  ok: boolean;
  output: string;
}

export interface PrResponseOutcome {
  agent: PrResponseAgentOutcome;
  verification: VerificationRun[];
  verified: boolean;
  sourceChanged: boolean;
  committed: boolean;
  headOid: string;
  checkpoint: "completed" | "rejected" | "skipped";
  checkpointRejection: string | null;
}

export interface PrResponseWorkerOptions {
  start: PrResponseStartEvent;
  transport: PrResponseTransport;
  git: LocalGit;
  agent: PrResponseAgent;
  runCommand: (
    command: string[],
    cwd: string,
  ) => Promise<{ ok: boolean; output: string }>;
  writeFile?: (path: string, content: string) => Promise<void>;
}

/**
 * PR対応worker。`implementation.ts`と同じ形だが、承認済みWHAT/HOWではなく
 * [ADR 0007](../../../docs/adr/0007-pull-request-response-job.md)のtriggerから
 * Agent loopを動かす。既に開いているcanonicalブランチの現在の先端からだけ始め、
 * 取り込み先の統合や引き継ぎ判定は行わない。
 */
export async function runPrResponseWorker({
  start,
  transport,
  git,
  agent,
  runCommand,
  writeFile = (path, content) => writeFileToDisk(path, content),
}: PrResponseWorkerOptions): Promise<PrResponseOutcome> {
  const worktree = start.worktreePath;
  const startingHead = await readHead(git, worktree);

  if (startingHead !== start.worktreeOid) {
    throw new Error(
      "the worktree is not at the canonical tip the checkpoint sealed",
    );
  }

  const agentOutcome = await agent.run(start);
  const sourceChanged = await hasChanges(git, worktree);
  const verification: VerificationRun[] = [];

  for (const command of start.verification) {
    const run = await runCommand(command, worktree);

    verification.push({ command, ok: run.ok, output: run.output });

    if (!run.ok) {
      break;
    }
  }

  const verified =
    start.verification.length > 0 &&
    verification.length === start.verification.length &&
    verification.every((run) => run.ok);

  const failing = verification.filter((run) => !run.ok);
  const pending = start.verification.slice(verification.length);
  const unresolved = [
    ...(agentOutcome.stopReason === "stop"
      ? []
      : [`- 未完了のAgent turn: 停止理由は\`${agentOutcome.stopReason}\``]),
    ...failing.map((run) => `- 失敗中の検証: \`${run.command.join(" ")}\``),
    ...pending.map((run) => `- 未実行の検証: \`${run.join(" ")}\``),
  ];

  if (verified && sourceChanged && unresolved.length === 0) {
    await git.run(["rm", "--ignore-unmatch", "-f", "HANDOFF.md"], worktree);
  } else {
    await writeFile(join(worktree, "HANDOFF.md"), handoff(start, unresolved));
  }

  const committed = await commitWorkInProgress(git, worktree, verified);
  const headOid = await readHead(git, worktree);

  const report = async (
    outcome: Omit<PrResponseOutcome, "agent" | "verification" | "verified">,
  ): Promise<PrResponseOutcome> => {
    await transport.write({
      type: "pr_response.result",
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      stopReason: agentOutcome.stopReason,
      acted: agentOutcome.acted,
      sourceChanged,
      verified,
    });

    return { agent: agentOutcome, verification, verified, ...outcome };
  };

  if (!committed || headOid === start.worktreeOid) {
    return report({
      sourceChanged,
      committed: false,
      headOid,
      checkpoint: "skipped",
      checkpointRejection: null,
    });
  }

  const request: CheckpointRequest = {
    type: "checkpoint.request",
    requestId: "checkpoint-1",
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    branchLeaseId: start.branchLeaseId,
    approvalFingerprint: start.approvalFingerprint,
    canonicalBranch: start.canonicalBranch,
    expectedOid: start.canonicalOid,
    headOid,
    verified,
  };

  await transport.write(request);

  const accepted = parseCheckpointEvent(await transport.read());

  if (accepted.type !== "checkpoint.accepted") {
    return report({
      sourceChanged,
      committed: true,
      headOid,
      checkpoint: "rejected",
      checkpointRejection:
        accepted.type === "checkpoint.rejected" ? accepted.reason : "unknown",
    });
  }

  const outcome = parseCheckpointEvent(await transport.read());

  return report({
    sourceChanged,
    committed: true,
    headOid,
    checkpoint:
      outcome.type === "checkpoint.completed" ? "completed" : "rejected",
    checkpointRejection:
      outcome.type === "checkpoint.rejected" ? outcome.reason : null,
  });
}

async function hasChanges(git: LocalGit, worktree: string): Promise<boolean> {
  const status = await git.run(["status", "--porcelain"], worktree);

  if (!status.ok) {
    throw new Error("the worktree status could not be read");
  }

  return status.stdout.trim() !== "";
}

async function readHead(git: LocalGit, worktree: string): Promise<string> {
  const head = await git.run(["rev-parse", "HEAD"], worktree);

  if (!head.ok) {
    throw new Error("the worktree HEAD could not be read");
  }

  return head.stdout.trim();
}

async function commitWorkInProgress(
  git: LocalGit,
  worktree: string,
  verified: boolean,
): Promise<boolean> {
  const staged = await git.run(["add", "-A"], worktree);

  if (!staged.ok) {
    throw new Error("the worktree changes could not be staged");
  }

  if (!(await hasChanges(git, worktree))) {
    return false;
  }

  const committed = await git.run(
    [
      "-c",
      `user.name=${identity.checkpointAuthor.name}`,
      "-c",
      `user.email=${identity.checkpointAuthor.email}`,
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      verified ? "checkpoint" : "checkpoint: WIP, verification failing",
    ],
    worktree,
  );

  if (!committed.ok) {
    throw new Error("the checkpoint commit failed");
  }

  return true;
}

function triggerSummary(start: PrResponseStartEvent): string {
  const { trigger } = start;

  if (trigger.kind === "review") {
    return `changes-requested review: ${trigger.body}`;
  }

  if (trigger.kind === "comment") {
    return `new comments (${trigger.comments.length})`;
  }

  return `required check failure: ${trigger.checkName} (${trigger.conclusion})`;
}

/** 別の実行環境がこの地点から再開するためのHANDOFF。 */
function handoff(start: PrResponseStartEvent, unresolved: string[]): string {
  return `# HANDOFF

このcheckpointは未検証の作業途中成果として引き継ぐ。引き継ぎ先は差分を読み、
検証を最初からやり直す。

## 現在地

- canonical branch: \`${start.canonicalBranch}\`
- pull request: #${start.prNumber}
- trigger: ${triggerSummary(start)}

## 未解決点

${unresolved.join("\n")}

## 次の一手

- 上の検証を通してから次の区切りへ進む。
`;
}
