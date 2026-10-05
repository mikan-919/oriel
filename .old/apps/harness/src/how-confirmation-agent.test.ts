import { expect, test } from "bun:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  HowConfirmationStartEvent,
  ModelStreamRequest,
} from "@mikan-919/oriel-contracts";

import { createHowConfirmationAgent } from "./how-confirmation-agent";
import {
  createHowConfirmationTools,
  type HowConfirmationTransport,
} from "./how-confirmation-tools";
import { createProxyStreamFn, type ModelStreamChannel } from "./model-channel";

function startEvent(
  overrides: Partial<HowConfirmationStartEvent> = {},
): HowConfirmationStartEvent {
  return {
    type: "how_confirmation.start",
    jobId: "linear-conversation:11:34:abc",
    jobLeaseId: "job-lease-1",
    repository: { owner: "acme", name: "widgets" },
    issueNumber: 34,
    linearIssueId: "lin-1",
    model: { provider: "lm-studio", id: "local-model" },
    linearIssue: { title: "Slow dashboard", description: "" },
    comments: [
      {
        id: "c1",
        authorIsActor: false,
        body: "@oriel how should we build this?",
      },
    ],
    trigger: { commentId: "c1", command: false },
    ...overrides,
  };
}

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

  return channel;
}

/** serve側のlinear_comment/linear_description応答を模す。 */
function fakeTransport(
  responses: Record<string, unknown[]>,
): HowConfirmationTransport & { written: unknown[] } {
  const written: unknown[] = [];
  const queues = new Map(
    Object.entries(responses).map(([type, events]) => [type, [...events]]),
  );

  return {
    written,
    write(message) {
      written.push(message);
    },
    async read() {
      const last = written.at(-1) as { type: string } | undefined;
      const requestType = last?.type ?? "";
      const queue = queues.get(requestType);
      const next = queue?.shift();

      if (next === undefined) {
        throw new Error(`no fake response queued for ${requestType}`);
      }

      return next;
    },
  };
}

test("the agent posts a comment through the tool and the transport carries the exact request", async () => {
  const transport = fakeTransport({
    "linear_comment.request": [
      {
        type: "linear_comment.accepted",
        requestId: "how-1",
        operationId: "op-1",
      },
      {
        type: "linear_comment.completed",
        requestId: "how-1",
        operationId: "op-1",
        linearCommentId: "comment-42",
      },
    ],
  });
  const start = startEvent();
  const toolset = createHowConfirmationTools({
    transport,
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    repository: start.repository,
    issueNumber: start.issueNumber,
    linearIssueId: start.linearIssueId,
    initialDescription: start.linearIssue.description,
  });

  // stateを変更するtool(Triage→Todoを含む)を一切提供しない。
  expect(toolset.tools.map((tool) => tool.name)).toEqual([
    "post_comment",
    "update_description",
  ]);

  const agent = createHowConfirmationAgent({
    streamFn: createProxyStreamFn({
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      model: start.model,
      channel: fauxChannel([
        fauxAssistantMessage([
          fauxToolCall("post_comment", { body: "What backend should we use?" }),
        ]),
        fauxAssistantMessage(fauxText("done")),
      ]),
    }),
    tools: toolset.tools,
  });

  const outcome = await agent.run(start);

  expect(outcome.acted).toBe(true);
  expect(outcome.stopReason).toBe("stop");
  expect(toolset.commentPosted()).toBe(true);
  expect(transport.written[0]).toMatchObject({
    type: "linear_comment.request",
    repository: start.repository,
    issueNumber: start.issueNumber,
    linearIssueId: start.linearIssueId,
    body: "What backend should we use?",
  });
});

test("a fallback comment is posted when the model never calls post_comment", async () => {
  const transport = fakeTransport({
    "linear_comment.request": [
      {
        type: "linear_comment.accepted",
        requestId: "how-1",
        operationId: "op-1",
      },
      {
        type: "linear_comment.completed",
        requestId: "how-1",
        operationId: "op-1",
        linearCommentId: "comment-43",
      },
    ],
  });
  const start = startEvent();
  const toolset = createHowConfirmationTools({
    transport,
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
      channel: fauxChannel([
        fauxAssistantMessage(fauxText("no action needed")),
      ]),
    }),
    tools: toolset.tools,
    ensureCommentPosted: async () => {
      if (toolset.commentPosted()) {
        return;
      }

      await toolset.tools
        .find((tool) => tool.name === "post_comment")
        ?.execute("fallback-ack", { body: "Noted." });
    },
  });

  const outcome = await agent.run(start);

  expect(outcome.acted).toBe(false);
  expect(toolset.commentPosted()).toBe(true);
  expect(transport.written[0]).toMatchObject({ body: "Noted." });
});

test("update_description sends the prior successful write as the next baseline, not the original turn value", async () => {
  const transport = fakeTransport({
    "linear_description.request": [
      { type: "linear_description.completed", requestId: "how-1" },
      { type: "linear_description.completed", requestId: "how-2" },
    ],
  });
  const start = startEvent({
    linearIssue: { title: "Slow dashboard", description: "original" },
  });
  const toolset = createHowConfirmationTools({
    transport,
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    repository: start.repository,
    issueNumber: start.issueNumber,
    linearIssueId: start.linearIssueId,
    initialDescription: start.linearIssue.description,
    newRequestId: (() => {
      let n = 0;
      return () => `how-${++n}`;
    })(),
  });
  const updateTool = toolset.tools.find(
    (tool) => tool.name === "update_description",
  );

  await updateTool?.execute("call-1", { description: "first draft" });
  await updateTool?.execute("call-2", { description: "second draft" });

  expect(transport.written).toEqual([
    expect.objectContaining({
      description: "first draft",
      baselineDescription: "original",
    }),
    expect.objectContaining({
      description: "second draft",
      baselineDescription: "first draft",
    }),
  ]);
});
