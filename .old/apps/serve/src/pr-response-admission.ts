import { identity } from "@mikan-919/oriel-identity";
import type { PrResponseTrigger } from "@mikan-919/oriel-contracts";

/**
 * [ADR 0007](../../../docs/adr/0007-pull-request-response-job.md)の対象PR判定と
 * trigger検出。
 *
 * discoveryのGitHub呼び出しは`pr-response-discovery.ts`と
 * `github-pr-response-ports.ts`が担い、ここには現在値だけから決まる純粋な判定
 * だけを置く。
 */
const canonicalBranchPattern = new RegExp(
  `^${identity.codeName}/.+-gh-(\\d+)-([0-9a-f]{64})$`,
);

export interface PrResponseCandidate {
  githubIssueNumber: number;
  approvalFingerprint: string;
}

/** headのcanonical branch名から、対象Workflowと承認指紋を復元する。 */
export function parseCanonicalBranchCandidate(
  headRef: string,
): PrResponseCandidate | null {
  const match = canonicalBranchPattern.exec(headRef);

  if (match === null) {
    return null;
  }

  return {
    githubIssueNumber: Number(match[1]),
    approvalFingerprint: match[2]!,
  };
}

export interface PrResponseReview {
  authorIsActor: boolean;
  state: string;
  submittedAt: string;
  body: string;
}

export interface PrResponseComment {
  authorIsActor: boolean;
  createdAt: string;
  body: string;
}

export interface PrResponseReviewComment extends PrResponseComment {
  path: string;
  line: number | null;
  body: string;
}

export interface PrResponseCheckFailure {
  checkName: string;
  conclusion: string;
  summary: string;
}

/** required checkの現在値。in progressのcheckは`conclusion`がnull。 */
export interface PrResponseCheckStatus {
  checkName: string;
  conclusion: string | null;
  summary: string;
}

export const failingCheckConclusions = new Set([
  "failure",
  "timed_out",
  "action_required",
]);

export const resolvedCheckConclusions = new Set(["success", "neutral"]);

export interface PrResponseActivity {
  reviews: PrResponseReview[];
  comments: PrResponseComment[];
  reviewComments: PrResponseReviewComment[];
  checkFailures: PrResponseCheckFailure[];
}

/** actor自身の直近の書き込みより新しい活動があるか。 */
function latestActorActivityAt(comments: PrResponseComment[]): string | null {
  const actorComments = comments.filter((comment) => comment.authorIsActor);

  if (actorComments.length === 0) {
    return null;
  }

  return actorComments
    .map((comment) => comment.createdAt)
    .sort()
    .at(-1)!;
}

function newerThan(value: string, since: string | null): boolean {
  return since === null || value.localeCompare(since) > 0;
}

/**
 * 一件のPull Requestについて、ADR 0007のtriggerを優先順位
 * (review > comment > check_failure)で判定する。checkFailuresは、対象checkの
 * 連続失敗回数が上限未満のものだけを呼び出し側が渡す。
 */
export function detectPrResponseTrigger(
  activity: PrResponseActivity,
): PrResponseTrigger | null {
  const since = latestActorActivityAt(activity.comments);

  const latestChangesRequested = activity.reviews
    .filter(
      (review) =>
        !review.authorIsActor &&
        review.state === "CHANGES_REQUESTED" &&
        newerThan(review.submittedAt, since),
    )
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
    .at(-1);

  if (latestChangesRequested !== undefined) {
    return {
      kind: "review",
      body: latestChangesRequested.body,
      comments: activity.reviewComments
        .filter(
          (comment) =>
            !comment.authorIsActor && newerThan(comment.createdAt, since),
        )
        .map(({ path, line, body }) => ({ path, line, body })),
    };
  }

  const newComments: PrResponseComment[] = [
    ...activity.comments,
    ...activity.reviewComments,
  ].filter(
    (comment) => !comment.authorIsActor && newerThan(comment.createdAt, since),
  );

  if (newComments.length > 0) {
    return {
      kind: "comment",
      comments: newComments.map((comment) => ({ body: comment.body })),
    };
  }

  const [checkFailure] = activity.checkFailures;

  return checkFailure === undefined
    ? null
    : {
        kind: "check_failure",
        checkName: checkFailure.checkName,
        conclusion: checkFailure.conclusion,
        summary: checkFailure.summary,
      };
}
