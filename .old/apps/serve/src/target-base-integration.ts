import { identity } from "@mikan-919/oriel-identity";

import { runGit, type GitCredential } from "./git";

export type TargetBaseIntegration =
  /** 取り込み先を含んだ先端。統合の要否にかかわらずこのOIDから再検証する。 */
  | { status: "integrated"; headOid: string }
  /** 自動では意味を決められない競合。人間またはAgentの判断が要る。 */
  | { status: "conflicted" }
  /** 取り込み先を読めない、または確認したOIDと一致しない。 */
  | { status: "unavailable" };

export interface IntegrateTargetBaseOptions {
  worktreePath: string;
  remote: string;
  targetBaseRef: string;
  /** 承認の読み直しで確認した取り込み先の現在OID。 */
  targetBaseOid: string;
  credential?: GitCredential | null;
}

/**
 * 同じ承認指紋のブランチを引き継いだ後、最新の取り込み先を安全に統合する。
 *
 * ADR 0004のとおり、canonicalブランチ作成後の取り込み先の前進は承認を失効させず、
 * 同じJobが最新状態を統合して検証をやり直す。ここでは統合だけを行い、検証は
 * harnessが引き継いだ先端に対して最初から実行する。
 *
 * 遠隔の先端が確認したOIDと一致しない、または競合した場合はfail closedとし、
 * 中断したmergeを残さない。
 */
export async function integrateTargetBase({
  worktreePath,
  remote,
  targetBaseRef,
  targetBaseOid,
  credential = null,
}: IntegrateTargetBaseOptions): Promise<TargetBaseIntegration> {
  const fetched = await runGit(
    ["fetch", "--no-tags", "--quiet", remote, targetBaseRef],
    { cwd: worktreePath, credential },
  );

  if (!fetched.ok) {
    return { status: "unavailable" };
  }

  const fetchedTip = await runGit(["rev-parse", "FETCH_HEAD"], {
    cwd: worktreePath,
  });

  // 確認済みの取り込み先OIDでなければ、何を統合するのか一意に決められない。
  if (!fetchedTip.ok || fetchedTip.stdout.trim() !== targetBaseOid) {
    return { status: "unavailable" };
  }

  const contained = await runGit(
    ["merge-base", "--is-ancestor", targetBaseOid, "HEAD"],
    { cwd: worktreePath },
  );

  if (contained.ok) {
    return head(worktreePath);
  }

  const merged = await runGit(
    [
      "-c",
      `user.name=${identity.checkpointAuthor.name}`,
      "-c",
      `user.email=${identity.checkpointAuthor.email}`,
      "merge",
      "--no-ff",
      "--no-edit",
      "--quiet",
      targetBaseOid,
    ],
    { cwd: worktreePath },
  );

  if (!merged.ok) {
    await runGit(["merge", "--abort"], { cwd: worktreePath });
    return { status: "conflicted" };
  }

  return head(worktreePath);
}

async function head(worktreePath: string): Promise<TargetBaseIntegration> {
  const read = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath });

  return read.ok
    ? { status: "integrated", headOid: read.stdout.trim() }
    : { status: "unavailable" };
}
