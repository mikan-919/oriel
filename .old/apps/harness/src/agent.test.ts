import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  ImplementationStartEvent,
  ModelStreamRequest,
  ModelStreamServerMessage,
} from "@mikan-919/oriel-contracts";

import { createImplementationAgent } from "./agent";
import { createProxyStreamFn, type ModelStreamChannel } from "./model-channel";
import { createWorktreeTools } from "./worktree-tools";

const digest = "a".repeat(64);
const sealedOid = "1".repeat(40);

function startEvent(
  worktreePath: string,
  overrides: Partial<ImplementationStartEvent> = {},
): ImplementationStartEvent {
  return {
    type: "implementation.start",
    jobId: `implementation:11:28:${digest}`,
    jobLeaseId: "job-lease-1",
    branchLeaseId: "branch-lease-1",
    approvalFingerprint: digest,
    canonicalBranch: `oriel/ENG-12-gh-28-${digest}`,
    canonicalOid: sealedOid,
    worktreeOid: sealedOid,
    worktreePath,
    adopted: false,
    model: { provider: "lm-studio", id: "local-model" },
    what: { title: "Add a greeting", body: "The CLI should greet." },
    how: { title: "Write greeting.txt", description: "Create greeting.txt." },
    verification: [["bun", "test"]],
    ...overrides,
  };
}

/**
 * `serve`側のmodel stream操作を模す。pi-aiのevent streamをそのまま運び、
 * harnessは再構成せずに同じ結果へ到達する。
 */
function fauxChannel(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
) {
  const faux = fauxProvider({
    provider: "lm-studio",
    models: [{ id: "local-model" }],
  });
  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses(responses);

  const requests: ModelStreamRequest[] = [];
  const channel: ModelStreamChannel = {
    async *open(request) {
      requests.push(request);

      const context = request.context as Parameters<
        typeof models.streamSimple
      >[1];

      for await (const event of models.streamSimple(faux.getModel(), context)) {
        yield {
          type: "model.stream.event",
          requestId: request.requestId,
          event,
        };
      }

      yield { type: "model.stream.end", requestId: request.requestId };
    },
    abort: () => {},
  };

  return { channel, requests };
}

async function withWorktree<T>(run: (worktreePath: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-agent-"));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("the Agent loop edits the source through tools before the harness verifies", async () => {
  await withWorktree(async (worktreePath) => {
    const { channel, requests } = fauxChannel([
      fauxAssistantMessage([
        fauxToolCall("write_file", {
          path: "greeting.txt",
          content: "hello\n",
        }),
      ]),
      fauxAssistantMessage(fauxText("greeting.txt now exists")),
    ]);
    const start = startEvent(worktreePath);
    const agent = createImplementationAgent({
      streamFn: createProxyStreamFn({
        jobId: start.jobId,
        jobLeaseId: start.jobLeaseId,
        model: start.model,
        channel,
      }),
      tools: createWorktreeTools({
        worktreePath,
        runCommand: async () => ({ ok: true, output: "" }),
      }),
    });

    const outcome = await agent.run(start);

    // tool実行の後に次のturnへ進み、実際にworktreeのsourceが変わっている。
    expect(outcome.toolCalls).toBe(1);
    expect(outcome.turns).toBe(2);
    expect(outcome.acted).toBe(true);
    expect(outcome.stopReason).toBe("stop");
    expect(await readFile(join(worktreePath, "greeting.txt"), "utf8")).toBe(
      "hello\n",
    );

    // 要求には論理識別子とJob取得IDだけが載り、credentialは載らない。
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      type: "model.stream.request",
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      provider: "lm-studio",
      model: "local-model",
    });
    expect(JSON.stringify(requests[0])).toContain("Write greeting.txt");
  });
});

test("a refused model stream stops the run instead of silently succeeding", async () => {
  await withWorktree(async (worktreePath) => {
    const channel: ModelStreamChannel = {
      async *open(request) {
        yield {
          type: "model.stream.rejected",
          requestId: request.requestId,
          reason: "ownership_not_current",
        } satisfies ModelStreamServerMessage;
      },
      abort: () => {},
    };
    const start = startEvent(worktreePath);
    const agent = createImplementationAgent({
      streamFn: createProxyStreamFn({
        jobId: start.jobId,
        jobLeaseId: start.jobLeaseId,
        model: start.model,
        channel,
      }),
      tools: [],
    });

    const outcome = await agent.run(start);

    expect(outcome.acted).toBe(false);
    expect(outcome.stopReason).toBe("error");
  });
});

test("a model stream that ends without a final message closes the turn as aborted", async () => {
  await withWorktree(async (worktreePath) => {
    const channel: ModelStreamChannel = {
      async *open(request) {
        yield {
          type: "model.stream.end",
          requestId: request.requestId,
        } satisfies ModelStreamServerMessage;
      },
      abort: () => {},
    };
    const start = startEvent(worktreePath);
    const agent = createImplementationAgent({
      streamFn: createProxyStreamFn({
        jobId: start.jobId,
        jobLeaseId: start.jobLeaseId,
        model: start.model,
        channel,
      }),
      tools: [],
    });

    expect((await agent.run(start)).stopReason).toBe("aborted");
  });
});
