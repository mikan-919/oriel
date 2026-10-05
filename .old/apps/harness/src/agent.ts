import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, ProviderId } from "@earendil-works/pi-ai";
import type { ImplementationStartEvent } from "@mikan-919/oriel-contracts";

export interface ImplementationAgentOutcome {
  turns: number;
  toolCalls: number;
  /** 最後のassistant turnの停止理由。`error`と`aborted`は未完了として扱う。 */
  stopReason: string;
  /** Agent loopが実際に編集またはtool実行を行ったか。 */
  acted: boolean;
}

/** worktree内で承認済みWHAT/HOWを実装するAgent loop。 */
export interface ImplementationAgent {
  run(start: ImplementationStartEvent): Promise<ImplementationAgentOutcome>;
  /** 実行中のturnを計画停止として中断する。実行中でなければ何もしない。 */
  abort(): void;
}

/**
 * 論理識別子だけを持つmodel記述。
 *
 * 実行ハーネスが指定してよいのは提供元とmodelの論理的な識別子だけであり、接続先、
 * 認証情報、互換性設定の正本は`serve`にある。ここにある値は`serve`が解決する
 * modelの代理であって、接続には使わない。
 */
export function logicalModel({
  provider,
  id,
}: ImplementationStartEvent["model"]): Model<Api> {
  return {
    id,
    name: id,
    // 実際のAPIとbaseUrlは`serve`が解決する。ここでは要求の組み立てにだけ使う。
    api: "openai-completions",
    provider: provider as ProviderId,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

/**
 * 承認済みWHAT/HOWだけを作業指示にするsystem prompt。
 *
 * 会話履歴やROADMAPはJobの入力にしない。実行できる範囲は封印済みworktreeの中に
 * 限られ、外部操作は`serve`が用途別に提供するものだけである。
 */
export function implementationSystemPrompt(
  start: ImplementationStartEvent,
): string {
  return `You are the implementation worker of a distributed execution harness.

You work only inside the approved worktree at ${start.worktreePath}, on the
canonical branch ${start.canonicalBranch}. Use the provided tools to read and
edit the source, and to run commands there.

Rules:
- The approved WHAT and HOW below are the only work order. Do not widen them.
- You hold no GitHub, Linear or model credential, and you cannot reach any
  service. Everything you need is in the worktree.
- Do not create commits, branches, tags or pull requests, and do not push. The
  harness commits and checkpoints your work after you stop.
- Do not write HANDOFF.md. The harness writes it.
- ${
    start.adopted
      ? "The branch tip is unverified work in progress from an earlier worker, already merged with the latest target base. Read the diff first, then continue or repair it."
      : "The branch starts at the target base. Implement the HOW from there."
  }
- Stop once the HOW is implemented. The harness then runs the repository
  verification commands, writes HANDOFF.md and checkpoints.`;
}

/** 承認済みWHATとHOWだけを渡す最初のprompt。 */
export function implementationPrompt(start: ImplementationStartEvent): string {
  return `# WHAT

${start.what.title}

${start.what.body}

# HOW

${start.how.title}

${start.how.description}`;
}

export interface CreateImplementationAgentOptions {
  streamFn: StreamFn;
  tools: AgentTool[];
}

/**
 * `@earendil-works/pi-agent-core`のAgent loopで実装を進める。
 *
 * 停止条件はAgent loop自身のturn終了に任せ、根拠のないturn上限を置かない。
 * providerの`StreamFn`は`serve`へのproxyであり、credentialはこのprocessに存在
 * しない。
 */
export function createImplementationAgent({
  streamFn,
  tools,
}: CreateImplementationAgentOptions): ImplementationAgent {
  let active: Agent | null = null;

  return {
    async run(start) {
      const agent = new Agent({
        streamFn,
        initialState: {
          systemPrompt: implementationSystemPrompt(start),
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

      await agent.prompt(implementationPrompt(start));

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
