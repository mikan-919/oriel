import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { HowConfirmationStartEvent } from "@mikan-919/oriel-contracts";

import { logicalModel } from "./agent";

export interface HowConfirmationAgentOutcome {
  turns: number;
  toolCalls: number;
  stopReason: string;
  acted: boolean;
}

export interface HowConfirmationAgent {
  run(start: HowConfirmationStartEvent): Promise<HowConfirmationAgentOutcome>;
}

/** Linear issue上の対話でHOWを確定するsystem prompt。 */
export function howConfirmationSystemPrompt(
  start: HowConfirmationStartEvent,
): string {
  return `You are the HOW-confirmation worker of a distributed execution harness.

You are having one turn of a conversation on a Linear issue (currently in
Triage) that corresponds to GitHub Issue #${start.issueNumber} in
${start.repository.owner}/${start.repository.name}. Your job is to help
converge on a clear HOW (the implementation approach), not to re-litigate
WHAT or write code.

Rules:
- The Linear issue description is the spec of record for HOW. Comments are
  conversation, not the spec. Whenever your understanding of HOW solidifies
  or changes, call update_description to write the confirmed HOW into the
  description.
- You may reply with post_comment to ask clarifying questions, summarize your
  understanding, or acknowledge instructions.
- You hold no Linear credential and cannot reach any service beyond the
  tools provided.
- You cannot move this issue out of Triage. Only a human moving it from
  Triage to Todo counts as execution approval. Never claim to have approved
  or started anything — once HOW is genuinely settled, say so and tell the
  human that moving the issue to Todo is the next step, but do not imply you
  can do it yourself.
- Stop once you have responded appropriately to the triggering comment below.`;
}

/** 起動時点のLinear issueとcommentの現在値だけを渡す最初のprompt。 */
export function howConfirmationPrompt(
  start: HowConfirmationStartEvent,
): string {
  const comments = start.comments
    .map(
      (comment) =>
        `### comment ${comment.id} by ${comment.authorIsActor ? "you (this harness)" : "a human"}${comment.id === start.trigger.commentId ? " (triggering comment)" : ""}\n\n${comment.body}`,
    )
    .join("\n\n");

  return `# Linear issue description (current HOW)

${start.linearIssue.title}

${start.linearIssue.description}

# Comments

${comments === "" ? "(none yet)" : comments}`;
}

export interface CreateHowConfirmationAgentOptions {
  streamFn: StreamFn;
  tools: AgentTool[];
  /**
   * Agentが一件もcommentを投稿しなかった場合の既定応答。discoveryの次trigger
   * 判定が読む「最新commentは既にharnessが応答した後か」という外部状態を、
   * Agentの選択にかかわらず必ず残す。
   */
  ensureCommentPosted?: () => Promise<void>;
}

export function createHowConfirmationAgent({
  streamFn,
  tools,
  ensureCommentPosted,
}: CreateHowConfirmationAgentOptions): HowConfirmationAgent {
  return {
    async run(start) {
      const agent = new Agent({
        streamFn,
        initialState: {
          systemPrompt: howConfirmationSystemPrompt(start),
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

      await agent.prompt(howConfirmationPrompt(start));
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
