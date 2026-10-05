import { expect, test } from "bun:test";

import { createJobRegistry, holdIfStarted } from "./job-registry";

function fakeJob(jobId: string) {
  const state = { status: "running", closed: false };
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = () => {
      state.status = "completed";
      resolve();
    };
  });

  return {
    state,
    finish,
    job: {
      jobId,
      finished,
      jobStatus: () => state.status,
      close: () => {
        state.closed = true;
      },
    },
  };
}

test("held Jobs appear in the list with their kind, and drop off once finished", async () => {
  const registry = createJobRegistry();
  const conversation = fakeJob("job-1");
  const implementation = fakeJob("job-2");

  registry.hold("issue_conversation", conversation.job);
  registry.hold("implementation", implementation.job);

  expect(registry.list()).toEqual([
    { jobId: "job-1", kind: "issue_conversation", status: "running" },
    { jobId: "job-2", kind: "implementation", status: "running" },
  ]);

  conversation.finish();
  await Bun.sleep(20);

  expect(conversation.state.closed).toBe(true);
  expect(registry.list()).toEqual([
    { jobId: "job-2", kind: "implementation", status: "running" },
  ]);
});

test("closeAll closes every held Job that is still running", () => {
  const registry = createJobRegistry();
  const what = fakeJob("job-1");
  const how = fakeJob("job-2");
  const prResponse = fakeJob("job-3");

  registry.hold("what_confirmation", what.job);
  registry.hold("how_confirmation", how.job);
  registry.hold("pr_response", prResponse.job);

  registry.closeAll();

  expect(what.state.closed).toBe(true);
  expect(how.state.closed).toBe(true);
  expect(prResponse.state.closed).toBe(true);
  expect(registry.list()).toEqual([]);
});

test("requestStop calls a held Job's requestStop and reports whether it was reachable", () => {
  const registry = createJobRegistry();
  const implementation = fakeJob("job-1");
  const stopRequests: string[] = [];

  registry.hold("implementation", {
    ...implementation.job,
    requestStop: () => stopRequests.push("job-1"),
  });
  registry.hold("issue_conversation", fakeJob("job-2").job);

  expect(registry.requestStop("job-1")).toBe(true);
  expect(stopRequests).toEqual(["job-1"]);
  // issue_conversationはrequestStopを持たない種別。
  expect(registry.requestStop("job-2")).toBe(false);
  expect(registry.requestStop("job-missing")).toBe(false);
});

test("holdIfStarted only registers results whose status is started", () => {
  const registry = createJobRegistry();
  const started = fakeJob("job-1");

  const startedResult = holdIfStarted(registry, "implementation", {
    status: "started" as const,
    ...started.job,
  });
  const refusedResult = holdIfStarted(registry, "implementation", {
    status: "refused" as const,
    reason: "device_not_registered",
  });

  expect(startedResult.status).toBe("started");
  expect(refusedResult.status).toBe("refused");
  expect(registry.list()).toEqual([
    { jobId: "job-1", kind: "implementation", status: "running" },
  ]);
});
