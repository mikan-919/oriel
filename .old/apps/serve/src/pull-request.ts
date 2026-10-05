import type { GitHubRepository } from "@mikan-919/oriel-contracts";

import type { ReconcileApproval } from "./implementation-admission";
import type { JobOwnershipVerifier } from "./issue-comments";

/** repository、head、baseの自然keyで見つかったPull Request候補。 */
export interface PullRequestCandidate {
  number: number;
}

/**
 * ADR 0004/0005のPull Request作成境界。
 *
 * 自然key(repository、head、base)だけで現在の候補を照合し、重複が見つかれば
 * 最小番号をcanonicalとして残す。credentialは`serve`が持つ。
 */
export interface PullRequestPorts {
  /** head/baseに一致する開いているPull Request一覧。読めない場合はnull。 */
  listOpenPullRequestsByHeadBase(input: {
    head: string;
    base: string;
  }): Promise<PullRequestCandidate[] | null>;
  createPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number } | "already_exists" | null>;
  /** canonicalへのリンクと理由を示す冪等なコメントを付けてcloseする。 */
  closeDuplicatePullRequest(input: {
    number: number;
    canonicalNumber: number;
  }): Promise<boolean>;
}

export type EnsurePullRequestStatus =
  | "created"
  | "adopted"
  | "ownership_not_current"
  | "approval_changed"
  | "approval_state_unknown"
  | "pull_request_state_unknown"
  | "pull_request_create_failed";

export interface EnsurePullRequestResult {
  status: EnsurePullRequestStatus;
  number: number | null;
}

export interface EnsurePullRequestTarget {
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
  approvalFingerprint: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface EnsurePullRequestOptions {
  ownership: JobOwnershipVerifier;
  ports: PullRequestPorts;
  /** 送信前の承認対象の再調停。変更と読取不能を区別する。 */
  reconcileApproval: ReconcileApproval;
  target: EnsurePullRequestTarget;
}

function refused(status: EnsurePullRequestStatus): EnsurePullRequestResult {
  return { status, number: null };
}

/**
 * 検証済み成果からレビュー可能なPull Requestを一意に作る。
 *
 * ADR 0004「取り込み先ブランチの前進とプルリクエスト作成時機」とADR 0005
 * 「Pull Request作成」のとおり、repository、head、baseの自然keyで作成前の
 * 候補を照合する。重複が見つかった場合は最小番号をcanonicalとして残し、
 * 余分な候補は理由を示す冪等なコメント付きでcloseする。canonical branchは
 * 承認指紋を含むため、head/baseの一致は同じ承認対象のPull Requestだけを指す。
 *
 * ponytail: ADRの自然keyは期待head OIDも含むが、GitHubのPull Request一覧は
 * head branch名でしか絞り込めない。canonical branch名自体が承認指紋を含み
 * head/baseの一致だけで版を一意に特定できるため、OIDでの追加照合は持たない。
 */
export async function ensurePullRequest({
  ownership,
  ports,
  reconcileApproval,
  target,
}: EnsurePullRequestOptions): Promise<EnsurePullRequestResult> {
  const current = await Promise.resolve(
    ownership.hasCurrentJobOwnership({
      jobId: target.jobId,
      jobLeaseId: target.jobLeaseId,
      repository: target.repository,
      issueNumber: target.issueNumber,
    }),
  ).catch(() => false);

  if (!current) {
    return refused("ownership_not_current");
  }

  const approval = await reconcileApproval().catch(
    () => ({ status: "unknown" }) as const,
  );

  if (approval.status === "unknown") {
    return refused("approval_state_unknown");
  }

  if (
    approval.status === "changed" ||
    approval.approvalFingerprint !== target.approvalFingerprint
  ) {
    return refused("approval_changed");
  }

  const open = await ports.listOpenPullRequestsByHeadBase({
    head: target.head,
    base: target.base,
  });

  if (open === null) {
    return refused("pull_request_state_unknown");
  }

  if (open.length > 0) {
    return { status: "adopted", number: await dedupe(ports, open) };
  }

  const created = await ports.createPullRequest({
    head: target.head,
    base: target.base,
    title: target.title,
    body: target.body,
  });

  if (created === null) {
    return refused("pull_request_create_failed");
  }

  if (created !== "already_exists") {
    return { status: "created", number: created.number };
  }

  // 作成の直前に別の試行が同じPull Requestを作った。現在値を読み直して収束する。
  const relisted = await ports.listOpenPullRequestsByHeadBase({
    head: target.head,
    base: target.base,
  });

  if (relisted === null || relisted.length === 0) {
    return refused("pull_request_create_failed");
  }

  return { status: "adopted", number: await dedupe(ports, relisted) };
}

/** 最小番号をcanonicalとして残し、余分な候補をcloseする。 */
async function dedupe(
  ports: PullRequestPorts,
  candidates: PullRequestCandidate[],
): Promise<number> {
  const [canonical, ...duplicates] = [...candidates].sort(
    (left, right) => left.number - right.number,
  );

  for (const duplicate of duplicates) {
    await ports
      .closeDuplicatePullRequest({
        number: duplicate.number,
        canonicalNumber: canonical!.number,
      })
      .catch(() => false);
  }

  return canonical!.number;
}
