import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { PrResponseStartEvent } from "@mikan-919/oriel-contracts";

import { logicalModel } from "./agent";

export interface PrResponseAgentOutcome {
  turns: number;
  toolCalls: number;
  /** 最後のassistant turnの停止理由。`error`と`aborted`は未完了として扱う。 */
  stopReason: string;
  acted: boolean;
}

/** worktree内で対象PRのfeedbackへ対応するAgent loop。 */
export interface PrResponseAgent {
  run(start: PrResponseStartEvent): Promise<PrResponseAgentOutcome>;
  /** 実行中のturnを計画停止として中断する。実行中でなければ何もしない。 */
  abort(): void;
}

function triggerPrompt(start: PrResponseStartEvent): string {
  const { trigger } = start;

  if (trigger.kind === "review") {
    const comments =
      trigger.comments.length === 0
        ? ""
        : `\n\nInline comments:\n${trigger.comments
            .map(
              (comment) =>
                `- ${comment.path}:${comment.line ?? "?"}: ${comment.body}`,
            )
            .join("\n")}`;

    return `# Changes requested review\n\n${trigger.body}${comments}`;
  }

  if (trigger.kind === "comment") {
    return `# New PR comments\n\n${trigger.comments
      .map((comment) => `- ${comment.body}`)
      .join("\n")}`;
  }

  return `# Required check failure\n\ncheck: ${trigger.checkName}\nconclusion: ${trigger.conclusion}\n\n${trigger.summary}`;
}

/** triggerだけを作業指示にするsystem prompt。 */
export function prResponseSystemPrompt(start: PrResponseStartEvent): string {
  return `You are the PR-response worker of a distributed execution harness.

You work only inside the approved worktree at ${start.worktreePath}, on the
canonical branch ${start.canonicalBranch}, which already backs pull request
#${start.prNumber}. Use the provided tools to read and edit the source, and to
run commands there.

Rules:
- The trigger below (a changes-requested review, new PR comments, or a
  required check failure) is the only work order. Do not widen it.
- You hold no GitHub, Linear or model credential, and you cannot reach any
  service. Everything you need is in the worktree.
- Do not create commits, branches, tags or pull requests, do not push, and do
  not merge or close the pull request. The harness commits and checkpoints
  your work after you stop.
- Do not write HANDOFF.md. The harness writes it.
- Stop once you have addressed the trigger. The harness then runs the
  repository verification commands, writes HANDOFF.md and checkpoints.`;
}

export interface CreatePrResponseAgentOptions {
  streamFn: StreamFn;
  tools: AgentTool[];
}

/**
 * `@earendil-works/pi-agent-core`のAgent loopでPRのfeedbackへ対応する。
 *
 * `agent.ts`の実装Agentと同じ形だが、system promptと最初のpromptがtriggerの
 * 内容から組み立てられる。
 */
export function createPrResponseAgent({
  streamFn,
  tools,
}: CreatePrResponseAgentOptions): PrResponseAgent {
  let active: Agent | null = null;

  return {
    async run(start) {
      const agent = new Agent({
        streamFn,
        initialState: {
          systemPrompt: prResponseSystemPrompt(start),
          model: logicalModel(start.model),
          tools,
        },
      });

      active = agent;

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

      await agent.prompt(triggerPrompt(start));

      active = null;

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
    abort() {
      active?.abort();
    },
  };
}
