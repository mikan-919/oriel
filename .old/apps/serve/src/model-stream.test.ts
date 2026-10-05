import { expect, test } from "bun:test";

import type { ModelStreamRequest } from "@mikan-919/oriel-contracts";

import {
  createModelStreamService,
  type ModelStreamBinding,
  type ModelStreamProvider,
} from "./model-stream";

const binding: ModelStreamBinding = {
  jobId: `implementation:11:28:${"a".repeat(64)}`,
  jobLeaseId: "job-lease-1",
  model: { provider: "lm-studio", id: "local-model" },
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
};

function request(
  overrides: Partial<ModelStreamRequest> = {},
): ModelStreamRequest {
  return {
    type: "model.stream.request",
    requestId: "model-1",
    jobId: binding.jobId,
    jobLeaseId: binding.jobLeaseId,
    provider: binding.model.provider,
    model: binding.model.id,
    context: { messages: [{ role: "user", content: "implement the HOW" }] },
    ...overrides,
  };
}

function ownership(current = true) {
  return { hasCurrentJobOwnership: () => current };
}

function fakeTranscript(recorded: { kind: string; content: string }[] = []) {
  return {
    append: (input: { kind: string; content: string }) =>
      void recorded.push({ kind: input.kind, content: input.content }),
    search: () => [],
  };
}

function fakeProvider(
  events: unknown[],
  seen: { provider: string; model: string; context: unknown }[] = [],
): ModelStreamProvider {
  return {
    async *stream({ provider, model, context }) {
      seen.push({ provider, model, context });

      for (const event of events) {
        yield event;
      }
    },
  };
}

async function collect(stream: AsyncIterable<unknown>) {
  const messages: unknown[] = [];

  for await (const message of stream) {
    messages.push(message);
  }

  return messages;
}

test("provider events reach the harness without being reshaped", async () => {
  const seen: { provider: string; model: string; context: unknown }[] = [];
  const recorded: { kind: string; content: string }[] = [];
  const service = createModelStreamService({
    binding,
    ownership: ownership(),
    provider: fakeProvider(
      [
        { type: "start", partial: {} },
        { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} },
      ],
      seen,
    ),
    transcript: fakeTranscript(recorded),
  });

  expect(await collect(service.stream(request()))).toEqual([
    {
      type: "model.stream.event",
      requestId: "model-1",
      event: { type: "start", partial: {} },
    },
    {
      type: "model.stream.event",
      requestId: "model-1",
      event: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} },
    },
    { type: "model.stream.end", requestId: "model-1" },
  ]);

  // credentialも接続先もharnessは知らない。論理識別子だけが渡る。
  expect(seen).toEqual([
    {
      provider: "lm-studio",
      model: "local-model",
      context: { messages: [{ role: "user", content: "implement the HOW" }] },
    },
  ]);

  // model-streamはこのAgent実行系だけを通る全Job種別のtranscriptを一箇所で記録する。
  expect(recorded.map((entry) => entry.kind)).toEqual([
    "model.stream.request",
    "model.stream.event",
    "model.stream.event",
  ]);
});

test("a request for another Job, lease or model is refused", async () => {
  const provider = fakeProvider([{ type: "start" }]);

  for (const overrides of [
    { jobId: "implementation:11:28:other" },
    { jobLeaseId: "job-lease-2" },
    { provider: "openai" },
    { model: "another-model" },
  ]) {
    const service = createModelStreamService({
      binding,
      ownership: ownership(),
      provider,
      transcript: fakeTranscript(),
    });

    expect(await collect(service.stream(request(overrides)))).toEqual([
      {
        type: "model.stream.rejected",
        requestId: "model-1",
        reason: "target_mismatch",
      },
    ]);
  }
});

test("a serve that lost the current Job ownership starts no model request", async () => {
  const seen: { provider: string; model: string; context: unknown }[] = [];
  const service = createModelStreamService({
    binding,
    ownership: ownership(false),
    provider: fakeProvider([{ type: "start" }], seen),
    transcript: fakeTranscript(),
  });

  expect(await collect(service.stream(request()))).toEqual([
    {
      type: "model.stream.rejected",
      requestId: "model-1",
      reason: "ownership_not_current",
    },
  ]);
  expect(seen).toEqual([]);
});

test("a model that cannot be used stops the run instead of falling back", async () => {
  const service = createModelStreamService({
    binding,
    ownership: ownership(),
    provider: {
      stream() {
        throw new Error("the configured model is unavailable");
      },
    },
    transcript: fakeTranscript(),
  });

  expect(await collect(service.stream(request()))).toEqual([
    {
      type: "model.stream.rejected",
      requestId: "model-1",
      reason: "model_unavailable",
    },
  ]);
});

test("a provider that fails mid-stream still terminates the stream", async () => {
  const service = createModelStreamService({
    binding,
    ownership: ownership(),
    provider: {
      async *stream() {
        yield { type: "start" };
        throw new Error("the provider connection dropped");
      },
    },
    transcript: fakeTranscript(),
  });

  expect(await collect(service.stream(request()))).toEqual([
    {
      type: "model.stream.event",
      requestId: "model-1",
      event: { type: "start" },
    },
    { type: "model.stream.end", requestId: "model-1" },
  ]);
});

test("an aborted request stops streaming and still ends the stream", async () => {
  let aborted = false;
  const service = createModelStreamService({
    binding,
    ownership: ownership(),
    provider: {
      async *stream({ signal }) {
        signal.addEventListener("abort", () => {
          aborted = true;
        });

        yield { type: "start" };

        while (!signal.aborted) {
          await Bun.sleep(1);
        }
      },
    },
    transcript: fakeTranscript(),
  });

  const messages: unknown[] = [];

  for await (const message of service.stream(request())) {
    messages.push(message);
    service.abort("model-1");
  }

  expect(aborted).toBe(true);
  expect(messages.at(-1)).toEqual({
    type: "model.stream.end",
    requestId: "model-1",
  });
});
