import { expect, test } from "bun:test";

import type {
  CheckpointRequest,
  ImplementationResult,
  ImplementationStartEvent,
  ModelStreamRequest,
} from "@mikan-919/oriel-contracts";

import { serveOwnedHarnessImplementationIpc } from "./implementation-ipc";

const digest = "a".repeat(64);
const sealedOid = "1".repeat(40);
const headOid = "2".repeat(40);

const start: ImplementationStartEvent = {
  type: "implementation.start",
  jobId: `implementation:11:28:${digest}`,
  jobLeaseId: "job-lease-1",
  branchLeaseId: "branch-lease-1",
  approvalFingerprint: digest,
  canonicalBranch: `oriel/ENG-12-gh-28-${digest}`,
  canonicalOid: sealedOid,
  worktreePath: "/worktrees/job",
  worktreeOid: sealedOid,
  adopted: false,
  model: { provider: "lm-studio", id: "local-model" },
  what: { title: "WHAT title", body: "WHAT body" },
  how: { title: "HOW title", description: "HOW description" },
  verification: [["bun", "test"]],
};

const checkpoint: CheckpointRequest = {
  type: "checkpoint.request",
  requestId: "checkpoint-1",
  jobId: start.jobId,
  jobLeaseId: start.jobLeaseId,
  branchLeaseId: start.branchLeaseId,
  approvalFingerprint: digest,
  canonicalBranch: start.canonicalBranch,
  expectedOid: sealedOid,
  headOid,
  verified: true,
};

function harnessStdout(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }

      controller.close();
    },
  });
}

function serveStdin() {
  const written: unknown[] = [];
  const decoder = new TextDecoder();

  return {
    written,
    stream: new WritableStream<Uint8Array>({
      write(chunk) {
        for (const line of decoder.decode(chunk).split("\n")) {
          if (line !== "") {
            written.push(JSON.parse(line));
          }
        }
      },
    }),
  };
}

function fakeService(
  outcome: "completed" | "rejected" = "completed",
  acceptance: "accepted" | "rejected" = "accepted",
) {
  const accepted: CheckpointRequest[] = [];
  const delivered: string[] = [];
  const modelRequests: ModelStreamRequest[] = [];
  const aborted: string[] = [];
  const reported: ImplementationResult[] = [];

  return {
    accepted,
    delivered,
    modelRequests,
    aborted,
    reported,
    service: {
      result: {
        report: (result: ImplementationResult) => {
          reported.push(result);
        },
      },
      model: {
        // eslint-disable-next-line require-yield
        stream: async function* (request: ModelStreamRequest) {
          modelRequests.push(request);
          throw new Error("this test does not reach the provider");
        },
        abort: (requestId: string) => {
          aborted.push(requestId);
        },
      },
      checkpoint: {
        accept: async (request: CheckpointRequest) => {
          accepted.push(request);

          return acceptance === "accepted"
            ? ({
                type: "checkpoint.accepted",
                requestId: request.requestId,
                operationId: "operation-1",
              } as const)
            : ({
                type: "checkpoint.rejected",
                requestId: request.requestId,
                reason: "ownership_not_current",
              } as const);
        },
        deliver: async (operationId: string) => {
          delivered.push(operationId);

          return outcome === "completed"
            ? ({
                type: "checkpoint.completed",
                requestId: "checkpoint-1",
                operationId,
                canonicalOid: headOid,
              } as const)
            : ({
                type: "checkpoint.rejected",
                requestId: "checkpoint-1",
                reason: "remote_diverged",
              } as const);
        },
      },
    },
  };
}

test("the harness is started with the sealed worktree and answered per checkpoint", async () => {
  const stdin = serveStdin();
  const { service, accepted, delivered } = fakeService();

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([checkpoint]),
    stdin.stream,
    start,
    service,
  );

  expect(accepted).toEqual([checkpoint]);
  expect(delivered).toEqual(["operation-1"]);
  expect(stdin.written).toEqual([
    start,
    {
      type: "checkpoint.accepted",
      requestId: "checkpoint-1",
      operationId: "operation-1",
    },
    {
      type: "checkpoint.completed",
      requestId: "checkpoint-1",
      operationId: "operation-1",
      canonicalOid: headOid,
    },
  ]);
});

test("a refused checkpoint is answered once and never delivered", async () => {
  const stdin = serveStdin();
  const { service, delivered } = fakeService("completed", "rejected");

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([checkpoint]),
    stdin.stream,
    start,
    service,
  );

  expect(delivered).toEqual([]);
  expect(stdin.written.slice(1)).toEqual([
    {
      type: "checkpoint.rejected",
      requestId: "checkpoint-1",
      reason: "ownership_not_current",
    },
  ]);
});

test("the explicit implementation result of this Job reaches the completion decision", async () => {
  const stdin = serveStdin();
  const { service, reported } = fakeService();
  const result: ImplementationResult = {
    type: "implementation.result",
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    stopReason: "error",
    acted: false,
    sourceChanged: false,
    verified: false,
  };

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([
      // 別のJobまたは古い取得IDの結果は、このJobの判断へ入れない。
      { ...result, jobLeaseId: "job-lease-0" },
      result,
    ]),
    stdin.stream,
    start,
    service,
  );

  expect(reported).toEqual([result]);
  // 結果には応答を返さない。
  expect(stdin.written).toEqual([start]);
});

test("a malformed or credential bearing request is refused without reaching the service", async () => {
  const stdin = serveStdin();
  const { service, accepted } = fakeService();

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([
      { type: "checkpoint.request", requestId: "checkpoint-9" },
      { ...checkpoint, installationToken: "must-not-cross-the-boundary" },
    ]),
    stdin.stream,
    start,
    service,
  );

  expect(accepted).toEqual([]);
  expect(stdin.written.slice(1)).toEqual([
    {
      type: "checkpoint.rejected",
      requestId: "checkpoint-9",
      reason: "invalid_request",
    },
    {
      type: "checkpoint.rejected",
      requestId: "checkpoint-1",
      reason: "invalid_request",
    },
  ]);
});

test("losing ownership closes the request path before the harness is served", async () => {
  const stdin = serveStdin();
  const { service, accepted } = fakeService();
  const lost = new AbortController();

  lost.abort();

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([checkpoint]),
    stdin.stream,
    start,
    service,
    lost.signal,
  );

  expect(accepted).toEqual([]);
  expect(stdin.written).toEqual([start]);
});

test("a user-requested stop sends a stop.request without touching checkpoint or model operations", async () => {
  const stdin = serveStdin();
  const { service, accepted } = fakeService();
  const userStop = new AbortController();

  userStop.abort();

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([]),
    stdin.stream,
    start,
    service,
    undefined,
    userStop.signal,
  );

  expect(accepted).toEqual([]);
  expect(stdin.written).toEqual([
    start,
    { type: "stop.request", jobId: start.jobId, jobLeaseId: start.jobLeaseId },
  ]);
});

test("model requests are streamed back per requestId and stay abortable while running", async () => {
  const stdin = serveStdin();
  const requests: ModelStreamRequest[] = [];
  const aborted: string[] = [];
  const modelRequest: ModelStreamRequest = {
    type: "model.stream.request",
    requestId: "model-1",
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    provider: "lm-studio",
    model: "local-model",
    context: { messages: [] },
  };

  await serveOwnedHarnessImplementationIpc(
    harnessStdout([
      modelRequest,
      { type: "model.stream.abort", requestId: "model-1" },
    ]),
    stdin.stream,
    start,
    {
      result: {
        report: () => {
          throw new Error("no result is reported here");
        },
      },
      checkpoint: {
        accept: async () => {
          throw new Error("no checkpoint is requested here");
        },
        deliver: async () => {
          throw new Error("no checkpoint is delivered here");
        },
      },
      model: {
        stream: async function* (request: ModelStreamRequest) {
          requests.push(request);

          // provider eventは別形式へ変換せず、そのまま運ぶ。
          yield {
            type: "model.stream.event",
            requestId: request.requestId,
            event: { type: "start" },
          } as const;
          yield {
            type: "model.stream.end",
            requestId: request.requestId,
          } as const;
        },
        abort: (requestId: string) => {
          aborted.push(requestId);
        },
      },
    },
  );

  // 論理識別子とJob取得IDだけが渡り、credentialは経路に存在しない。
  expect(requests).toEqual([modelRequest]);
  // 中止messageはstreamの完了を待たずに届く。
  expect(aborted).toEqual(["model-1"]);
  expect(stdin.written).toEqual([
    start,
    {
      type: "model.stream.event",
      requestId: "model-1",
      event: { type: "start" },
    },
    { type: "model.stream.end", requestId: "model-1" },
  ]);
});
