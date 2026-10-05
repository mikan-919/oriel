import {
  GitPullRequest,
  Hammer,
  HelpCircle,
  MessageCircle,
  Route,
} from "lucide-react";

export interface Job {
  jobId: string;
  kind:
    | "issue_conversation"
    | "implementation"
    | "what_confirmation"
    | "how_confirmation"
    | "pr_response";
  status: string | null;
}

/**
 * `/api/jobs`は稼働中のJobしか返さないので、ログ検索の当たりは終了済みJobが
 * 大半になる。種別をnullにして「記録から開いたJob」として扱う。
 */
export type SelectedJob = { kind: Job["kind"] | null } & Omit<Job, "kind">;

export const finishedJobLabel = "記録から開いたJob";

export const kindLabel: Record<Job["kind"], string> = {
  issue_conversation: "Issue対話",
  implementation: "実装",
  what_confirmation: "WHAT確定",
  how_confirmation: "HOW確定",
  pr_response: "PR対応",
};

export const kindIcon: Record<
  Job["kind"],
  React.ComponentType<{ size?: number; className?: string }>
> = {
  issue_conversation: MessageCircle,
  implementation: Hammer,
  what_confirmation: HelpCircle,
  how_confirmation: Route,
  pr_response: GitPullRequest,
};

/** 実行に時間がかかり、計画停止に応じるJob種別。 */
export const stoppableKinds: Set<Job["kind"]> = new Set([
  "implementation",
  "pr_response",
]);

/** 一覧に残っているJobは稼働中が既定。明確な拒否/失敗語だけ静止表示にする。 */
export function statusTone(status: string | null): "live" | "fail" {
  if (status === null) {
    return "live";
  }

  const lowered = status.toLowerCase();

  return lowered.includes("fail") ||
    lowered.includes("refused") ||
    lowered.includes("error")
    ? "fail"
    : "live";
}
