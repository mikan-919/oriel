import { expect, test } from "bun:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  ModelStreamRequest,
  WhatConfirmationStartEvent,
} from "@mikan-919/oriel-contracts";

import { createProxyStreamFn, type ModelStreamChannel } from "./model-channel";
import { createWhatConfirmationAgent } from "./what-confirmation-agent";
import {
  createWhatConfirmationTools,
  type WhatConfirmationTransport,
} from "./what-confirmation-tools";

function startEvent(
  overrides: Partial<WhatConfirmationStartEvent> = {},
): WhatConfirmationStartEvent {
  return {
    type: "what_confirmation.start",
    jobId: "what-confirmation:11:28:comment-1",
    jobLeaseId: "job-lease-1",
    repository: { owner: "acme", name: "widgets" },
    issueNumber: 28,
    model: { provider: "lm-studio", id: "local-model" },
    issue: { title: "Slow dashboard", body: "" },
    comments: [
      { id: 1, authorLogin: "human", body: "@oriel what should we do?" },
    ],
    trigger: { commentId: 1, command: false },
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

/** serve側のissue_comment/issue_body/linear_triage_link応答を模す。 */
function fakeTransport(
  responses: Record<string, unknown[]>,
): WhatConfirmationTransport & { written: unknown[] } {
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
    "issue_comment.request": [
      {
        type: "issue_comment.accepted",
        requestId: "what-1",
        operationId: "op-1",
      },
      {
        type: "issue_comment.completed",
        requestId: "what-1",
        operationId: "op-1",
        githubCommentId: 42,
      },
    ],
  });
  const start = startEvent();
  const toolset = createWhatConfirmationTools({
    transport,
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    repository: start.repository,
    issueNumber: start.issueNumber,
    allowLinearTriageLink: false,
  });

  expect(toolset.tools.map((tool) => tool.name)).toEqual([
    "post_comment",
    "update_issue_body",
  ]);

  const agent = createWhatConfirmationAgent({
    streamFn: createProxyStreamFn({
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      model: start.model,
      channel: fauxChannel([
        fauxAssistantMessage([
          fauxToolCall("post_comment", { body: "Could you clarify the goal?" }),
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
    type: "issue_comment.request",
    repository: start.repository,
    issueNumber: start.issueNumber,
    body: "Could you clarify the goal?",
  });
});

test("a fallback comment is posted when the model never calls post_comment", async () => {
  const transport = fakeTransport({
    "issue_comment.request": [
      {
        type: "issue_comment.accepted",
        requestId: "what-1",
        operationId: "op-1",
      },
      {
        type: "issue_comment.completed",
        requestId: "what-1",
        operationId: "op-1",
        githubCommentId: 43,
      },
    ],
  });
  const start = startEvent();
  const toolset = createWhatConfirmationTools({
    transport,
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    repository: start.repository,
    issueNumber: start.issueNumber,
    allowLinearTriageLink: false,
  });
  const agent = createWhatConfirmationAgent({
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

test("ensure_linear_triage_link is only offered on an explicit command turn", () => {
  const transport = fakeTransport({});
  const mentionOnly = createWhatConfirmationTools({
    transport,
    jobId: "job",
    jobLeaseId: "lease",
    repository: { owner: "acme", name: "widgets" },
    issueNumber: 1,
    allowLinearTriageLink: false,
  });
  const commanded = createWhatConfirmationTools({
    transport,
    jobId: "job",
    jobLeaseId: "lease",
    repository: { owner: "acme", name: "widgets" },
    issueNumber: 1,
    allowLinearTriageLink: true,
  });

  expect(
    mentionOnly.tools.some((tool) => tool.name === "ensure_linear_triage_link"),
  ).toBe(false);
  expect(
    commanded.tools.some((tool) => tool.name === "ensure_linear_triage_link"),
  ).toBe(true);
});
