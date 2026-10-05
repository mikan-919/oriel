import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { WhatConfirmationStartEvent } from "@mikan-919/oriel-contracts";

import { logicalModel } from "./agent";

export interface WhatConfirmationAgentOutcome {
  turns: number;
  toolCalls: number;
  stopReason: string;
  acted: boolean;
}

export interface WhatConfirmationAgent {
  run(start: WhatConfirmationStartEvent): Promise<WhatConfirmationAgentOutcome>;
}

/** GitHub Issue上の対話でWHATを確定するsystem prompt。 */
export function whatConfirmationSystemPrompt(
  start: WhatConfirmationStartEvent,
): string {
  return `You are the WHAT-confirmation worker of a distributed execution harness.

You are having one turn of a conversation on GitHub Issue #${start.issueNumber}
in ${start.repository.owner}/${start.repository.name}. Your job is to help
converge on a clear WHAT (what problem to solve), not to design HOW or write
code.

Rules:
- The Issue body is the spec of record for WHAT. Comments are conversation,
  not the spec. Whenever your understanding of WHAT solidifies or changes,
  call update_issue_body to write the confirmed WHAT into the body.
- You may reply with post_comment to ask clarifying questions, summarize your
  understanding, or acknowledge instructions.
- You hold no GitHub or Linear credential and cannot reach any service beyond
  the tools provided.
- ${
    start.trigger.command
      ? "This turn was triggered by an explicit human command to proceed. If, and only if, WHAT is genuinely settled, call ensure_linear_triage_link to create or link the Linear issue for HOW consideration. If the corresponding Linear issue already has more than one match, the tool will refuse — report that to the human instead of guessing."
      : "This turn was triggered by a plain mention, not an explicit instruction to proceed. Do not attempt to create or link a Linear issue this turn; continue the WHAT dialogue instead."
  }
- Stop once you have responded appropriately to the triggering comment below.`;
}

/** 起動時点のIssueとcommentの現在値だけを渡す最初のprompt。 */
export function whatConfirmationPrompt(
  start: WhatConfirmationStartEvent,
): string {
  const comments = start.comments
    .map(
      (comment) =>
        `### comment #${comment.id} by ${comment.authorLogin}${comment.id === start.trigger.commentId ? " (triggering comment)" : ""}\n\n${comment.body}`,
    )
    .join("\n\n");

  return `# Issue body (current WHAT)

${start.issue.title}

${start.issue.body}

# Comments

${comments === "" ? "(none yet)" : comments}`;
}

export interface CreateWhatConfirmationAgentOptions {
  streamFn: StreamFn;
  tools: AgentTool[];
  /**
   * Agentが一件もcommentを投稿しなかった場合の既定応答。discoveryの次trigger
   * 判定が読む「最新commentは既にharnessが応答した後か」という外部状態を、
   * Agentの選択にかかわらず必ず残す。
   */
  ensureCommentPosted?: () => Promise<void>;
}

export function createWhatConfirmationAgent({
  streamFn,
  tools,
  ensureCommentPosted,
}: CreateWhatConfirmationAgentOptions): WhatConfirmationAgent {
  return {
    async run(start) {
      const agent = new Agent({
        streamFn,
        initialState: {
          systemPrompt: whatConfirmationSystemPrompt(start),
          model: logicalModel(start.model),
          tools,
        },
      });

      let turns = 0;
      let toolCalls = 0;

      agent.subscribe((event) => {
        if (event.type === "turn_end") {
          turns += 1;
        }

        if (event.type === "tool_execution_end") {
          toolCalls += 1;
        }
      });

      await agent.prompt(whatConfirmationPrompt(start));
      await ensureCommentPosted?.();

      const last = [...agent.state.messages]
        .reverse()
        .find((message) => message.role === "assistant");

      return {
        turns,
        toolCalls,
        stopReason:
          last !== undefined && "stopReason" in last
            ? String(last.stopReason)
            : "unknown",
        acted: toolCalls > 0,
      };
    },
  };
}
