import { identity } from "@mikan-919/oriel-identity";

import {
  approvalFingerprint,
  canonicalBranchName,
  canonicalRefName,
} from "./approval-fingerprint";
import type { ExecutionConfigPort } from "./execution-config";

/**
 * 実装Jobの正式なadmission。
 *
 * [ADR 0003](../../../docs/adr/0003-approval-admission-and-reconciliation.md)の
 * 手順2〜7のうち、外部の現在値だけから決まる部分をここに置く。所有権の取得、
 * 二度目・三度目の読み直しの順序、workerの起動は`implementation-job.ts`が持つ。
 *
 * 満たせない入力とprovider APIの能力不足はすべてfail closedにする。弱いcreate
 * APIや逐次更新へのfallbackはしない。
 */
export interface LinearApprovalSnapshot {
  /** Linear IssueのUUID。 */
  issueId: string;
  identifier: string;
  title: string;
  description: string | null;
  /** 現在のworkflow state名。実行承認とみなすのはTodoだけとする。 */
  stateName: string;
  attachmentUrls: string[];
}

export interface GitHubIssueSnapshot {
  issueNumber: number;
  issueNodeId: string;
  repositoryNodeId: string;
  title: string;
  body: string | null;
  state: string;
}

export type RefRead =
  | { status: "present"; oid: string }
  | { status: "absent" }
  /** 読めなかった。存在の有無を決めない。 */
  | { status: "unknown" };

export type SealOutcome =
  | "sealed"
  | "rejected"
  /** installation/tokenがatomicな`updateRefs`を使えない。 */
  | "unsupported"
  /** timeout、切断、曖昧な応答。送ったかどうかを決めない。 */
  | "unknown";

export interface ImplementationApprovalPorts extends ExecutionConfigPort {
  readLinearIssue(
    linearIssueId: string,
  ): Promise<LinearApprovalSnapshot | null>;
  /** attachment URLから対象repositoryのIssueを逆引きする。対象外はnull。 */
  resolveGitHubIssueByAttachmentUrl(
    url: string,
  ): Promise<GitHubIssueSnapshot | null>;
  /** 取り込み先Git参照とその現在OID。 */
  readTargetBase(): Promise<{ ref: string; oid: string } | null>;
  readRef(qualifiedRef: string): Promise<RefRead>;
  /** 開いているプルリクエストのhead ref。読めない場合はnull。 */
  listOpenPullRequestHeadRefs(): Promise<string[] | null>;
  checkRefFormat(branch: string): Promise<boolean>;
  /** GraphQLの`updateRefs`一回だけで作る比較条件付きの作成。 */
  updateRefsAtomically(input: {
    repositoryNodeId: string;
    baseRef: string;
    expectedBaseOid: string;
    canonicalRef: string;
  }): Promise<SealOutcome>;
}

export interface ImplementationApproval {
  jobId: string;
  approvalFingerprint: string;
  canonicalBranch: string;
  canonicalRef: string;
  targetBaseRef: string;
  targetBaseOid: string;
  githubIssueNumber: number;
  githubIssueNodeId: string;
  githubRepositoryNodeId: string;
  linearIssueId: string;
  linearIdentifier: string;
}

/**
 * 外部操作の直前に行う承認対象の再調停。
 *
 * ADR 0005のとおり、単なる提供元障害と承認の変更を区別する。読めなかった場合は
 * `unknown`として盲目的な再送も差し戻しもせず、現在値を読み直して収束させる。
 */
export type ApprovalReconciliation =
  | { status: "current"; approvalFingerprint: string }
  /** 現在値から、承認対象が変わったと確定できた。 */
  | { status: "changed" }
  /** 現在値を読めず、変わったかどうかを決められない。 */
  | { status: "unknown" };

export type ReconcileApproval = () => Promise<ApprovalReconciliation>;

export type ImplementationRefusalReason =
  | "linear_issue_not_found"
  | "linear_state_not_todo"
  | "github_issue_not_uniquely_attached"
  | "github_issue_not_open"
  | "approval_fingerprint_unavailable"
  | "canonical_branch_unavailable"
  | "target_base_unavailable"
  | "pull_request_state_unknown"
  | "workflow_pull_request_open"
  | "workflow_not_fenced"
  | "ownership_not_current"
  | "approval_changed"
  | "canonical_branch_state_unknown"
  | "branch_adoption_unavailable"
  | "branch_seal_unsupported"
  | "branch_seal_rejected"
  | "branch_seal_result_unknown";

/**
 * 承認済みのWHATとHOWの現在値。
 *
 * ADR 0003のとおり、これは承認指紋の入力であって正本ではない。Job識別子、所有権
 * キー、branch名、外部操作要求、ローカルDBへは保存せず、workerへ渡すためだけに
 * その読み取りの間だけ保持する。
 */
export interface ApprovedContent {
  whatTitle: string;
  whatBody: string;
  howTitle: string;
  howDescription: string;
}

export type ImplementationApprovalRead =
  | {
      status: "read";
      approval: ImplementationApproval;
      content: ApprovedContent;
    }
  | { status: "refused"; reason: ImplementationRefusalReason };

export type SealResult =
  /** 比較条件付き作成でcanonicalブランチを封印した。 */
  | { status: "sealed"; canonicalOid: string }
  /** 同じ承認指紋の既存ブランチを、未検証の作業途中成果として引き継ぐ。 */
  | { status: "adopted"; canonicalOid: string }
  | { status: "refused"; reason: ImplementationRefusalReason };

/** 実行承認とみなすLinearのworkflow state名。 */
export const approvedStateName = "Todo";

/**
 * 承認後にworker起動直後の機械的な反映で入るstate名。
 *
 * ADR 0005のとおり、これは承認そのものではなく承認後の状態反映であり、`serve`
 * だけが送る。実行承認は人間のTriage→Todoだけである。
 */
export const inProgressStateName = "In Progress";

/** admissionが受理するstate。承認そのものを読むので、Todoだけとする。 */
const admittedStateNames: readonly string[] = [approvedStateName];

/**
 * worker起動後の再調停が受理するstate。
 *
 * 起動直後に`serve`自身がTodoからIn Progressへ移すため、実行中の現在値はどちらも
 * 同じ承認episodeを指す。どちらでもないstateだけを、確定した承認の変更とする。
 */
export const reconciledStateNames: readonly string[] = [
  approvedStateName,
  inProgressStateName,
];

/** 実装Job識別子の、承認指紋を除いたWorkflow部分。 */
function jobIdPrefix(repositoryId: number, githubIssueNumber: number): string {
  return `implementation:${repositoryId}:${githubIssueNumber}:`;
}

/**
 * 同じWorkflowのcanonicalブランチか。
 *
 * routing部分のLinear identifierは変わりうるため、branch名の先頭では判定せず、
 * GitHub issue numberの位置だけで同じWorkflowを見分ける。
 *
 * 接頭辞は`canonicalBranchName`が書くものと同じ正本(`identity`)から取る。ここで
 * 直書きすると、識別子を変えたときにこの判定が全ブランチをfalseへ倒し、
 * `workflowIsFenced`が隔離済みとして通してしまう(fail open)。
 */
function belongsToWorkflow(branch: string, githubIssueNumber: number): boolean {
  return (
    branch.startsWith(`${identity.codeName}/`) &&
    branch.includes(`-gh-${githubIssueNumber}-`)
  );
}

/**
 * ADR 0003のWorkflow全体の置換隔離。
 *
 * 同じWorkflowで、異なるJob識別子のコード変更Jobが現在の接続を持っていないことを
 * 確認する。旧ブランチのGit参照が物理的に残るだけなら非有効であり、この確認を
 * 妨げない。現在値を読めない場合はfail closedにする。
 */
export function workflowIsFenced(
  live: { jobKeys: string[]; branchKeys: string[] } | null,
  approval: ImplementationApproval,
  repositoryId: number,
): boolean {
  if (live === null) {
    return false;
  }

  const prefix = jobIdPrefix(repositoryId, approval.githubIssueNumber);
  const branchPrefix = `${repositoryId}/`;

  return (
    live.jobKeys.every(
      (key) => !key.startsWith(prefix) || key === approval.jobId,
    ) &&
    live.branchKeys.every((key) => {
      if (!key.startsWith(branchPrefix)) {
        return true;
      }

      const branch = key.slice(branchPrefix.length);

      return (
        !belongsToWorkflow(branch, approval.githubIssueNumber) ||
        branch === approval.canonicalBranch
      );
    })
  );
}

/**
 * 読み直しの拒否理由が、現在値から承認の変更だと確定できるか。
 *
 * ADR 0003の一致判定のうち、Linear stateがその読み取りで受理するstateのどれでも
 * なくなった、attachmentからGitHub Issueが一意に解決しなくなった、対象Issueが
 * 開いていないという観測は、すべて現在値から読み取れた承認対象の変更である。
 * 読めなかった、能力が足りない、別のphaseへ進んだという理由はここに含めない。
 */
export function approvalChangedByRead(
  reason: ImplementationRefusalReason,
): boolean {
  return (
    reason === "linear_state_not_todo" ||
    reason === "github_issue_not_uniquely_attached" ||
    reason === "github_issue_not_open"
  );
}

function refused(reason: ImplementationRefusalReason): {
  status: "refused";
  reason: ImplementationRefusalReason;
} {
  return { status: "refused", reason };
}

/**
 * 現在値だけから承認指紋、canonicalブランチ、Job識別子を導く読み取り。
 *
 * 受理するLinear stateは呼び出し文脈で決まる。admissionは実行承認そのものを読む
 * のでTodoだけを受理し、worker起動後の再調停は`reconciledStateNames`を渡して、
 * `serve`自身が反映したIn Progressを承認の変更と誤認しないようにする。
 */
export async function readImplementationApproval(
  ports: ImplementationApprovalPorts,
  {
    repositoryId,
    linearIssueId,
  }: { repositoryId: number; linearIssueId: string },
  acceptedStateNames: readonly string[] = admittedStateNames,
): Promise<ImplementationApprovalRead> {
  const linear = await ports.readLinearIssue(linearIssueId);

  if (linear === null) {
    return refused("linear_issue_not_found");
  }

  if (!acceptedStateNames.includes(linear.stateName)) {
    return refused("linear_state_not_todo");
  }

  const resolved = await Promise.all(
    linear.attachmentUrls.map((url) =>
      ports.resolveGitHubIssueByAttachmentUrl(url),
    ),
  );
  const issues = new Map<string, GitHubIssueSnapshot>();

  for (const issue of resolved) {
    if (issue !== null) {
      issues.set(issue.issueNodeId, issue);
    }
  }

  if (issues.size !== 1) {
    return refused("github_issue_not_uniquely_attached");
  }

  const [issue] = [...issues.values()];

  if (issue === undefined || issue.state.toLowerCase() !== "open") {
    return refused("github_issue_not_open");
  }

  let fingerprint;

  try {
    fingerprint = approvalFingerprint({
      repositoryId: issue.repositoryNodeId,
      githubIssueNodeId: issue.issueNodeId,
      githubTitle: issue.title,
      githubBody: issue.body,
      linearIssueUuid: linear.issueId,
      linearTitle: linear.title,
      linearDescription: linear.description,
    });
  } catch {
    return refused("approval_fingerprint_unavailable");
  }

  let canonicalBranch;

  try {
    canonicalBranch = canonicalBranchName({
      linearIdentifier: linear.identifier,
      githubIssueNumber: issue.issueNumber,
      approvalFingerprint: fingerprint,
    });
  } catch {
    return refused("canonical_branch_unavailable");
  }

  if (!(await ports.checkRefFormat(canonicalBranch))) {
    return refused("canonical_branch_unavailable");
  }

  const base = await ports.readTargetBase();

  if (base === null) {
    return refused("target_base_unavailable");
  }

  // Workflow全体の置換隔離。実装中はプルリクエストが存在してはならない。
  const openHeadRefs = await ports.listOpenPullRequestHeadRefs();

  if (openHeadRefs === null) {
    return refused("pull_request_state_unknown");
  }

  if (
    openHeadRefs.some((headRef) =>
      belongsToWorkflow(headRef, issue.issueNumber),
    )
  ) {
    return refused("workflow_pull_request_open");
  }

  return {
    status: "read",
    content: {
      whatTitle: issue.title,
      whatBody: issue.body ?? "",
      howTitle: linear.title,
      howDescription: linear.description ?? "",
    },
    approval: {
      jobId: `${jobIdPrefix(repositoryId, issue.issueNumber)}${fingerprint}`,
      approvalFingerprint: fingerprint,
      canonicalBranch,
      canonicalRef: canonicalRefName(canonicalBranch),
      targetBaseRef: base.ref,
      targetBaseOid: base.oid,
      githubIssueNumber: issue.issueNumber,
      githubIssueNodeId: issue.issueNodeId,
      githubRepositoryNodeId: issue.repositoryNodeId,
      linearIssueId: linear.issueId,
      linearIdentifier: linear.identifier,
    },
  };
}

/**
 * 二つの読み取りが同じ承認対象を指すか。
 *
 * ADR 0004のとおり、既存ブランチを引き継ぐ場合だけ、同じ取り込み先Git参照の
 * OID前進を承認の失効として扱わない。取り込み先の参照そのものは一致を要する。
 */
export function sameApproval(
  first: ImplementationApproval,
  second: ImplementationApproval,
  { allowTargetBaseAdvance = false } = {},
): boolean {
  const compared = (approval: ImplementationApproval) =>
    allowTargetBaseAdvance
      ? { ...approval, targetBaseOid: "" }
      : { ...approval };

  return JSON.stringify(compared(first)) === JSON.stringify(compared(second));
}

/**
 * ADR 0003手順6と7。canonical refが不存在のときだけ、target baseの不変と
 * canonical refの不存在を同じatomic updateの比較条件にして一回だけ作る。
 * 曖昧な応答は再送せず、read-backで確定できたときだけsealとする。
 *
 * 同じ承認指紋のGit参照が既に存在する場合は、ADR 0004の引き継ぎとして現在の
 * 先端をそのまま採る。強制送信、reset、上書きはしない。呼び出し側が読んだ
 * canonical refの現在値を渡し、ここでは読み直さない。
 */
export async function sealCanonicalBranch(
  ports: ImplementationApprovalPorts,
  approval: ImplementationApproval,
  canonical: RefRead,
): Promise<SealResult> {
  if (canonical.status === "unknown") {
    return refused("canonical_branch_state_unknown");
  }

  if (canonical.status === "present") {
    return { status: "adopted", canonicalOid: canonical.oid };
  }

  const base = await ports.readTargetBase();

  if (base === null) {
    return refused("target_base_unavailable");
  }

  if (
    base.ref !== approval.targetBaseRef ||
    base.oid !== approval.targetBaseOid
  ) {
    return refused("approval_changed");
  }

  const outcome = await ports.updateRefsAtomically({
    repositoryNodeId: approval.githubRepositoryNodeId,
    baseRef: approval.targetBaseRef,
    expectedBaseOid: approval.targetBaseOid,
    canonicalRef: approval.canonicalRef,
  });

  if (outcome === "sealed") {
    return { status: "sealed", canonicalOid: approval.targetBaseOid };
  }

  if (outcome === "unsupported") {
    return refused("branch_seal_unsupported");
  }

  if (outcome === "rejected") {
    return refused("branch_seal_rejected");
  }

  // 結果不明。成功として再送せず、両方のrefを読み直して確定できたときだけ進む。
  const [createdRef, baseAfter] = await Promise.all([
    ports.readRef(approval.canonicalRef),
    ports.readTargetBase(),
  ]);

  return createdRef.status === "present" &&
    createdRef.oid === approval.targetBaseOid &&
    baseAfter !== null &&
    baseAfter.ref === approval.targetBaseRef &&
    baseAfter.oid === approval.targetBaseOid
    ? { status: "sealed", canonicalOid: approval.targetBaseOid }
    : refused("branch_seal_result_unknown");
}
