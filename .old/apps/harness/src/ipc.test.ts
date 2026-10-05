import { expect, test } from "bun:test";

import { createHarnessMessageRouter } from "./ipc";

async function collect(stream: AsyncIterable<unknown>) {
  const messages: unknown[] = [];

  for await (const message of stream) {
    messages.push(message);
  }

  return messages;
}

test("model stream messages reach their own subscription, others stay in order", async () => {
  const router = createHarnessMessageRouter();
  const stream = router.open("model-1");

  router.deliver({
    type: "model.stream.event",
    requestId: "model-1",
    event: 1,
  });
  router.deliver({
    type: "checkpoint.accepted",
    requestId: "checkpoint-1",
    operationId: "operation-1",
  });
  router.deliver({ type: "model.stream.end", requestId: "model-1" });
  router.deliver({
    type: "checkpoint.completed",
    requestId: "checkpoint-1",
    operationId: "operation-1",
  });

  expect(await collect(stream)).toEqual([
    { type: "model.stream.event", requestId: "model-1", event: 1 },
    { type: "model.stream.end", requestId: "model-1" },
  ]);
  expect(await router.read()).toMatchObject({ type: "checkpoint.accepted" });
  expect(await router.read()).toMatchObject({ type: "checkpoint.completed" });
});

test("an unknown model stream requestId is not silently dropped", async () => {
  const router = createHarnessMessageRouter();

  router.deliver({ type: "model.stream.event", requestId: "other", event: 1 });

  expect(await router.read()).toMatchObject({ requestId: "other" });
});

test("a stop request reaches the registered handler instead of the general queue", async () => {
  const router = createHarnessMessageRouter();
  const stopped: unknown[] = [];

  router.onStop(() => stopped.push("stopped"));
  router.deliver({
    type: "stop.request",
    jobId: "job-1",
    jobLeaseId: "lease-1",
  });
  router.deliver({
    type: "checkpoint.accepted",
    requestId: "checkpoint-1",
    operationId: "operation-1",
  });

  expect(stopped).toEqual(["stopped"]);
  expect(await router.read()).toMatchObject({ type: "checkpoint.accepted" });
});

test("a stop request delivered before any handler is registered is dropped, not queued", async () => {
  const router = createHarnessMessageRouter();

  router.deliver({
    type: "stop.request",
    jobId: "job-1",
    jobLeaseId: "lease-1",
  });
  router.deliver({
    type: "checkpoint.accepted",
    requestId: "checkpoint-1",
    operationId: "operation-1",
  });

  expect(await router.read()).toMatchObject({ type: "checkpoint.accepted" });
});

test("a closed router ends every open subscription rather than hanging", async () => {
  const router = createHarnessMessageRouter();
  const stream = router.open("model-1");

  router.close();

  expect(await collect(stream)).toEqual([]);
  expect(await router.read()).toBeUndefined();
});
