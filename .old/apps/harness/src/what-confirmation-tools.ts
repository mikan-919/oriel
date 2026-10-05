import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  parseIssueBodyUpdateEvent,
  parseIssueCommentEvent,
  parseLinearTriageLinkEvent,
  type GitHubRepository,
} from "@mikan-919/oriel-contracts";

export interface WhatConfirmationTransport {
  write(message: unknown): void | Promise<void>;
  read(): Promise<unknown>;
}

export interface WhatConfirmationToolsOptions {
  transport: WhatConfirmationTransport;
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
  /** Linearへの新規作成・紐付けは、明示的なcommandを受けたturnだけ提供する。 */
  allowLinearTriageLink: boolean;
  newRequestId?: () => string;
}

export interface WhatConfirmationToolset {
  tools: AgentTool[];
  /** post_commentが実際にGitHubへ投稿できたか。discoveryの次trigger判定が読む外部状態を必ず残すため、呼び出し側は失敗時にfallback commentを送る。 */
  commentPosted(): boolean;
}

/**
 * WHAT確定Jobだけが持つ狭いtool群。
 *
 * ADR 0005のとおりharnessへGitHub・Linearの汎用API中継は公開しない。ここにある
 * のはIssueへのcomment投稿、Issue本文の更新、Linear Triage作成・紐付けの三つに
 * 限る。branch、commit、実装用のfile操作は持たない。
 */
export function createWhatConfirmationTools({
  transport,
  jobId,
  jobLeaseId,
  repository,
  issueNumber,
  allowLinearTriageLink,
  newRequestId,
}: WhatConfirmationToolsOptions): WhatConfirmationToolset {
  let posted = false;
  let requestCounter = 0;
  const nextRequestId = newRequestId ?? (() => `what-${++requestCounter}`);

  function text(content: string) {
    return { content: [{ type: "text" as const, text: content }], details: {} };
  }

  function stringField(params: unknown, name: string): string {
    const value =
      typeof params === "object" && params !== null
        ? (params as Record<string, unknown>)[name]
        : undefined;

    if (typeof value !== "string") {
      throw new Error(`${name} must be a string`);
    }

    return value;
  }

  const tools: AgentTool[] = [
    {
      name: "post_comment",
      label: "Post a comment",
      description: "Post a reply comment on this GitHub Issue.",
      parameters: Type.Object({ body: Type.String() }),
      async execute(_toolCallId, params) {
        await transport.write({
          type: "issue_comment.request",
          requestId: nextRequestId(),
          jobId,
          jobLeaseId,
          repository,
          issueNumber,
          body: stringField(params, "body"),
        });

        const accepted = parseIssueCommentEvent(await transport.read());

        if (accepted.type === "issue_comment.rejected") {
          return text(`rejected: ${accepted.reason}`);
        }

        const outcome = parseIssueCommentEvent(await transport.read());

        if (outcome.type === "issue_comment.completed") {
          posted = true;
          return text(`posted comment #${outcome.githubCommentId}`);
        }

        return text(
          outcome.type === "issue_comment.rejected"
            ? `rejected: ${outcome.reason}`
            : "comment pending reconciliation",
        );
      },
    },
    {
      name: "update_issue_body",
      label: "Update the Issue body",
      description:
        "Replace this GitHub Issue's body with the currently confirmed WHAT. " +
        "Prior comments are not the spec of record; only this body is. Call " +
        "this whenever your understanding of WHAT solidifies or changes.",
      parameters: Type.Object({ body: Type.String() }),
      async execute(_toolCallId, params) {
        await transport.write({
          type: "issue_body.request",
          requestId: nextRequestId(),
          jobId,
          jobLeaseId,
          repository,
          issueNumber,
          body: stringField(params, "body"),
        });

        const outcome = parseIssueBodyUpdateEvent(await transport.read());

        return text(
          outcome.type === "issue_body.completed"
            ? "issue body updated"
            : `rejected: ${outcome.reason}`,
        );
      },
    },
  ];

  if (allowLinearTriageLink) {
    tools.push({
      name: "ensure_linear_triage_link",
      label: "Create or link the Linear issue",
      description:
        "Only call this after a human has explicitly instructed you to " +
        "proceed to HOW. Creates a Linear issue in Triage if none is linked " +
        "to this GitHub Issue yet, or returns the already-linked one. Never " +
        "call this to merely acknowledge a mention.",
      parameters: Type.Object({
        title: Type.String(),
        description: Type.String(),
      }),
      async execute(_toolCallId, params) {
        await transport.write({
          type: "linear_triage_link.request",
          requestId: nextRequestId(),
          jobId,
          jobLeaseId,
          repository,
          issueNumber,
          title: stringField(params, "title"),
          description: stringField(params, "description"),
        });

        const outcome = parseLinearTriageLinkEvent(await transport.read());

        return text(
          outcome.type === "linear_triage_link.completed"
            ? `linked Linear issue ${outcome.linearIssueId}`
            : `rejected: ${outcome.reason}`,
        );
      },
    });
  }

  return { tools, commentPosted: () => posted };
}
