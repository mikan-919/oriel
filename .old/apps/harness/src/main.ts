import {
  parseHowConfirmationStartEvent,
  parseImplementationStartEvent,
  parsePrResponseStartEvent,
  parseWhatConfirmationStartEvent,
  type ImplementationClientMessage,
  type PrResponseClientMessage,
} from "@mikan-919/oriel-contracts";

import { createImplementationAgent } from "./agent";
import { systemLocalGit } from "./git";
import { createHowConfirmationAgent } from "./how-confirmation-agent";
import { createHowConfirmationTools } from "./how-confirmation-tools";
import { runImplementationWorker } from "./implementation";
import { createHarnessMessageRouter } from "./ipc";
import {
  createNdjsonIssueCommentOperationClient,
  postIssueConversationReply,
} from "./issue-conversation";
import { createProxyStreamFn, type ModelStreamChannel } from "./model-channel";
import { createPrResponseAgent } from "./pr-response-agent";
import { runPrResponseWorker } from "./pr-response";
import { runCommand } from "./run-command";
import { createWhatConfirmationAgent } from "./what-confirmation-agent";
import { createWhatConfirmationTools } from "./what-confirmation-tools";
import { createWorktreeTools } from "./worktree-tools";

/**
 * Job単位のharness process。credentialを持たず、`serve`が与えた対象と取得IDの
 * 範囲でだけ、`serve`の狭い外部操作を要求する。
 */
function argument(name: string): string {
  const flag = `--${name}`;
  const index = Bun.argv.indexOf(flag);
  const value = index < 0 ? undefined : Bun.argv[index + 1];

  if (value === undefined || value === "") {
    throw new Error(`${flag} is required`);
  }

  return value;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return {};
  }
}

const decoder = new TextDecoder();
let buffer = "";
const router = createHarnessMessageRouter();

// stdinのNDJSONを読み、要求の対応付けだけをここで行う。
void (async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line !== "") {
        // `serve`側のparseLineと同じく、不正な行でstreamを殺さない。ここでthrow
        // するとvoidされたこのIIFEがunhandled rejectionになり、stdinの読み取り
        // だけが止まってrouter.close()も呼ばれず、Agentが来ない応答を待ち続ける。
        router.deliver(parseLine(line));
      }
    }
  }

  // 切断は待ち続けるturnを残さない。
  router.close();
})();

function read(): Promise<unknown> {
  return router.read();
}

function write(message: unknown): number | Promise<number> {
  return Bun.stdout.write(`${JSON.stringify(message)}\n`);
}

const mode = Bun.argv.includes("--mode") ? argument("mode") : "issue";

if (mode === "implementation") {
  // 封印済みworktreeと承認済みWHAT/HOWだけをstart eventとして受け取る。
  const start = parseImplementationStartEvent(await read());
  // modelへの要求は`serve`のmodel stream操作へ中継する。credentialは持たない。
  const channel: ModelStreamChannel = {
    open(request) {
      const stream = router.open(request.requestId);

      write(request);

      return stream;
    },
    abort(requestId) {
      write({ type: "model.stream.abort", requestId });
    },
  };
  const implementationAgent = createImplementationAgent({
    streamFn: createProxyStreamFn({
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      model: start.model,
      channel,
    }),
    tools: createWorktreeTools({
      worktreePath: start.worktreePath,
      runCommand,
    }),
  });

  router.onStop(() => implementationAgent.abort());

  const outcome = await runImplementationWorker({
    start,
    transport: {
      // 結果messageを書き終えるまでprocessを終わらせない。
      write: async (message: ImplementationClientMessage) => {
        await write(message);
      },
      read,
    },
    git: systemLocalGit,
    agent: implementationAgent,
    runCommand,
  });

  process.stderr.write(
    `implementation ${outcome.checkpoint} verified=${outcome.verified} agent=${outcome.agent.stopReason}\n`,
  );
  process.exit(outcome.checkpoint === "rejected" ? 1 : 0);
}

if (mode === "pr-response") {
  // 既に開いているPull Requestのcanonicalブランチの現在の先端だけを受け取る。
  const start = parsePrResponseStartEvent(await read());
  const channel: ModelStreamChannel = {
    open(request) {
      const stream = router.open(request.requestId);

      write(request);

      return stream;
    },
    abort(requestId) {
      write({ type: "model.stream.abort", requestId });
    },
  };
  const prResponseAgent = createPrResponseAgent({
    streamFn: createProxyStreamFn({
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      model: start.model,
      channel,
    }),
    tools: createWorktreeTools({
      worktreePath: start.worktreePath,
      runCommand,
    }),
  });

  router.onStop(() => prResponseAgent.abort());

  const outcome = await runPrResponseWorker({
    start,
    transport: {
      write: async (message: PrResponseClientMessage) => {
        await write(message);
      },
      read,
    },
    git: systemLocalGit,
    agent: prResponseAgent,
    runCommand,
  });

  process.stderr.write(
    `pr_response ${outcome.checkpoint} verified=${outcome.verified} agent=${outcome.agent.stopReason}\n`,
  );
  process.exit(outcome.checkpoint === "rejected" ? 1 : 0);
}

if (mode === "what") {
  const start = parseWhatConfirmationStartEvent(await read());
  const channel: ModelStreamChannel = {
    open(request) {
      const stream = router.open(request.requestId);

      write(request);

      return stream;
    },
    abort(requestId) {
      write({ type: "model.stream.abort", requestId });
    },
  };
  const toolset = createWhatConfirmationTools({
    transport: {
      write: async (message) => {
        await write(message);
      },
      read,
    },
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    repository: start.repository,
    issueNumber: start.issueNumber,
    allowLinearTriageLink: start.trigger.command,
  });
  const agent = createWhatConfirmationAgent({
    streamFn: createProxyStreamFn({
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      model: start.model,
      channel,
    }),
    tools: toolset.tools,
    ensureCommentPosted: async () => {
      if (toolset.commentPosted()) {
        return;
      }

      const postComment = toolset.tools.find(
        (tool) => tool.name === "post_comment",
      );

      await postComment?.execute("fallback-ack", {
        body: "Noted — no further action needed right now.",
      });
    },
  });

  const outcome = await agent.run(start);

  await write({
    type: "what_confirmation.result",
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    stopReason: outcome.stopReason,
    acted: outcome.acted,
  });

  process.stderr.write(
    `what_confirmation acted=${outcome.acted} agent=${outcome.stopReason}\n`,
  );
  process.exit(0);
}

if (mode === "how") {
  const start = parseHowConfirmationStartEvent(await read());
  const channel: ModelStreamChannel = {
    open(request) {
      const stream = router.open(request.requestId);

      write(request);

      return stream;
    },
    abort(requestId) {
      write({ type: "model.stream.abort", requestId });
    },
  };
  const toolset = createHowConfirmationTools({
    transport: {
      write: async (message) => {
        await write(message);
      },
      read,
    },
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    repository: start.repository,
    issueNumber: start.issueNumber,
    linearIssueId: start.linearIssueId,
    initialDescription: start.linearIssue.description,
  });
  const agent = createHowConfirmationAgent({
    streamFn: createProxyStreamFn({
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      model: start.model,
      channel,
    }),
    tools: toolset.tools,
    ensureCommentPosted: async () => {
      if (toolset.commentPosted()) {
        return;
      }

      const postComment = toolset.tools.find(
        (tool) => tool.name === "post_comment",
      );

      await postComment?.execute("fallback-ack", {
        body: "Noted — no further action needed right now.",
      });
    },
  });

  const outcome = await agent.run(start);

  await write({
    type: "how_confirmation.result",
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    stopReason: outcome.stopReason,
    acted: outcome.acted,
  });

  process.stderr.write(
    `how_confirmation acted=${outcome.acted} agent=${outcome.stopReason}\n`,
  );
  process.exit(0);
}

const [owner, name] = argument("repository").split("/");

if (owner === undefined || name === undefined) {
  throw new Error("--repository must be owner/name");
}

const operationClient = createNdjsonIssueCommentOperationClient({
  write: async (message) => {
    await write(message);
  },
  read,
});

await postIssueConversationReply(
  {
    requestId: argument("request"),
    jobId: argument("job"),
    jobLeaseId: argument("lease"),
    repository: { owner, name },
    issueNumber: Number(argument("issue")),
    body: argument("body"),
  },
  operationClient,
  (event) => {
    process.stderr.write(`${event.type}\n`);
  },
);

// 返答が完了したらJob processを終える。stdinのreaderで生き残らせない。
process.exit(0);
