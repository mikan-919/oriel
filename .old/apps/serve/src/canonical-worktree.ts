import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { runGit, type GitCredential } from "./git";

export interface CanonicalWorktreeOptions {
  /** `serve`が持つrepositoryのclone。 */
  repositoryRoot: string;
  worktreesRoot: string;
  jobId: string;
  canonicalBranch: string;
  /** 封印または引き継ぎで確認したcanonicalブランチの先端。 */
  canonicalOid: string;
  /** remote名またはURL。 */
  remote: string;
  credential?: GitCredential | null;
}

export interface CanonicalWorktree {
  path: string;
  /**
   * sandboxの削除。
   *
   * ADR 0005のとおり、削除してよいのは復元可能でcleanなsandboxだけとする。
   * `restorableOids`は遠隔から復元できると確認済みの先端であり、作業ツリーに
   * 差分がある、先端がそのいずれでもない、または読めない場合は削除しない。
   */
  remove(restorableOids: readonly string[]): Promise<"removed" | "kept">;
}

/** worktree pathへJob識別子をそのまま使わず、pathとして安全な形にする。 */
function worktreeName(jobId: string): string {
  return jobId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * 封印済みcanonicalブランチのworktreeを開く。
 *
 * ADR 0004のとおり、遠隔の先端が確認したOIDと一致する場合だけ開く。一致しない、
 * または読めない場合はworkerを始めさせずfail closedにする。credentialはこの
 * fetchの中だけで使い、worktreeにもharnessにも置かない。
 */
export async function openCanonicalWorktree({
  repositoryRoot,
  worktreesRoot,
  jobId,
  canonicalBranch,
  canonicalOid,
  remote,
  credential = null,
}: CanonicalWorktreeOptions): Promise<CanonicalWorktree | null> {
  const fetched = await runGit(
    ["fetch", "--no-tags", "--quiet", remote, `refs/heads/${canonicalBranch}`],
    { cwd: repositoryRoot, credential },
  );

  if (!fetched.ok) {
    return null;
  }

  const head = await runGit(["rev-parse", "FETCH_HEAD"], {
    cwd: repositoryRoot,
  });

  if (!head.ok || head.stdout.trim() !== canonicalOid) {
    return null;
  }

  const path = join(worktreesRoot, worktreeName(jobId));

  await mkdir(worktreesRoot, { recursive: true });
  await rm(path, { force: true, recursive: true });
  await runGit(["worktree", "prune"], { cwd: repositoryRoot });

  const added = await runGit(
    ["worktree", "add", "--quiet", "-B", canonicalBranch, path, canonicalOid],
    { cwd: repositoryRoot },
  );

  if (!added.ok) {
    return null;
  }

  return {
    path,
    async remove(restorableOids) {
      const [status, head] = await Promise.all([
        runGit(["status", "--porcelain"], { cwd: path }),
        runGit(["rev-parse", "HEAD"], { cwd: path }),
      ]);

      // 未commitの差分、復元できない先端、読めない状態はそのまま残す。
      if (
        !status.ok ||
        status.stdout.trim() !== "" ||
        !head.ok ||
        !restorableOids.includes(head.stdout.trim())
      ) {
        return "kept";
      }

      // `--force`を使わない。Gitがcleanと認めた場合だけ消える。
      const removed = await runGit(["worktree", "remove", path], {
        cwd: repositoryRoot,
      });

      if (!removed.ok) {
        return "kept";
      }

      await rm(path, { force: true, recursive: true });

      return "removed";
    },
  };
}

export type CheckpointPushResult =
  /** 期待した先端になった。 */
  | { status: "pushed"; canonicalOid: string }
  /** 現在値が第三のOIDになっている。再調停が要る。 */
  | { status: "diverged"; canonicalOid: string }
  /** 送信も現在値の確認もできなかった。 */
  | { status: "failed" };

async function readRemoteTip(
  worktreePath: string,
  remote: string,
  canonicalBranch: string,
  credential: GitCredential | null,
): Promise<string | null> {
  const listed = await runGit(
    ["ls-remote", remote, `refs/heads/${canonicalBranch}`],
    { cwd: worktreePath, credential },
  );

  if (!listed.ok) {
    return null;
  }

  const [line] = listed.stdout.trim().split("\n");

  return line === undefined || line === ""
    ? null
    : (line.split("\t")[0] ?? null);
}

/**
 * checkpointをcanonicalブランチへ送る。
 *
 * ADR 0005の収束規則に従い、送信前OIDを`--force-with-lease`の比較条件にする。
 * 結果が不明でも盲目的に再送せず、現在値を読み直して同じ比較条件のときだけ
 * 一度だけ再送する。第三のOIDでは送らずに再調停へ返す。
 */
export async function pushCheckpoint({
  worktreePath,
  remote,
  canonicalBranch,
  expectedOid,
  headOid,
  credential = null,
}: {
  worktreePath: string;
  remote: string;
  canonicalBranch: string;
  expectedOid: string;
  headOid: string;
  credential?: GitCredential | null;
}): Promise<CheckpointPushResult> {
  const ref = `refs/heads/${canonicalBranch}`;
  const push = () =>
    runGit(
      [
        "push",
        "--quiet",
        `--force-with-lease=${ref}:${expectedOid}`,
        remote,
        `${headOid}:${ref}`,
      ],
      { cwd: worktreePath, credential },
    );

  await push();

  const afterFirst = await readRemoteTip(
    worktreePath,
    remote,
    canonicalBranch,
    credential,
  );

  if (afterFirst === headOid) {
    return { status: "pushed", canonicalOid: headOid };
  }

  if (afterFirst === null) {
    return { status: "failed" };
  }

  if (afterFirst !== expectedOid) {
    return { status: "diverged", canonicalOid: afterFirst };
  }

  // 送信前OIDのままなら、同じ比較条件でもう一度だけ送る。
  await push();

  const afterResend = await readRemoteTip(
    worktreePath,
    remote,
    canonicalBranch,
    credential,
  );

  if (afterResend === headOid) {
    return { status: "pushed", canonicalOid: headOid };
  }

  return afterResend === null || afterResend === expectedOid
    ? { status: "failed" }
    : { status: "diverged", canonicalOid: afterResend };
}
