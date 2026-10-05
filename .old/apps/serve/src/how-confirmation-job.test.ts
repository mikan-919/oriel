import { expect, test } from "bun:test";

import type { DeviceTokenStore } from "./device-registration";
import type { LinearApprovalReader } from "./github-approval-ports";
import {
  startHowConfirmationJob,
  type HowConfirmationLinearPorts,
} from "./how-confirmation-job";
import type { LinearIssueConversationAdmission } from "./how-confirmation-admission";
import type { StartHowConfirmationWorkerOptions } from "./how-confirmation-worker";
import { startFakeOwnershipRelay } from "./ownership-relay.fake";

const deviceToken = "34.linear-conversation.device-token";
const repositoryId = 34;
const repository = { owner: "mikan-919", name: "oriel" };
const linearIssueId = "lin-34";

function tokenStore(token: string | null): DeviceTokenStore {
  return { set: async () => {}, get: async () => token };
}

function fakeAdmission(
  fingerprint: () => string,
): LinearIssueConversationAdmission {
  return {
    admit: async ({ repositoryId: id, issueNumber }) => ({
      status: "admitted",
      jobId: `linear-conversation:${id}:${issueNumber}:${fingerprint()}`,
      approvalFingerprint: fingerprint(),
    }),
    reconfirm: async ({ approvalFingerprint }) =>
      approvalFingerprint === fingerprint(),
  };
}

function fakeReader(): LinearApprovalReader {
  return {
    readIssue: async () => ({
      issueId: linearIssueId,
      identifier: "ORI-34",
      title: "HOW draft",
      description: "本文",
      stateName: "Triage",
      attachmentUrls: [],
    }),
  };
}

function fakeLinearPorts(created: { bodies: string[] }): {
  ports: HowConfirmationLinearPorts;
  createdCommentIds: string[];
} {
  const createdCommentIds: string[] = [];
  let nextId = 0;

  return {
    createdCommentIds,
    ports: {
      reader: fakeReader(),
      commentPublisher: {
        createComment: async ({ body }) => {
          created.bodies.push(body);
          const id = `comment-${++nextId}`;
          createdCommentIds.push(id);
          return { id };
        },
        getViewerId: async () => "oriel-actor",
        listComments: async () => [],
        deleteComment: async () => {},
      },
      descriptionPublisher: {
        updateDescription: async () => {},
        readDescription: async () => null,
      },
    },
  };
}

function fakeWorker(captured: {
  options: StartHowConfirmationWorkerOptions | null;
}) {
  return (options: StartHowConfirmationWorkerOptions) => {
    captured.options = options;

    return {
      finished: Promise.resolve(),
      jobStatus: () => "completed",
      close: () => {},
    };
  };
}

function baseOptions(relayOrigin: string) {
  return {
    relayOrigin,
    tokenStore: tokenStore(deviceToken),
    createAdmission: () => fakeAdmission(() => "fingerprint-1"),
    databasePath: ":memory:",
    harnessEntry: new URL("../../harness/src/main.ts", import.meta.url)
      .pathname,
    repositoryId,
    repository,
    issueNumber: 34,
    linearIssueId,
    model: { provider: "test-provider", id: "test-model" },
    modelProvider: { stream: async function* () {} },
    heartbeatStopMs: 500,
  };
}

test("a web-authored body is posted as a new Linear comment and becomes the worker's trigger", async () => {
  const relay = startFakeOwnershipRelay(deviceToken);
  const created = { bodies: [] as string[] };
  const { ports, createdCommentIds } = fakeLinearPorts(created);
  const captured: { options: StartHowConfirmationWorkerOptions | null } = {
    options: null,
  };

  try {
    const started = await startHowConfirmationJob({
      ...baseOptions(relay.origin),
      trigger: { body: "人間が書いた返答", command: false },
      createLinearPorts: async () => ports,
      createWorker: fakeWorker(captured),
    });

    expect(started.status).toBe("started");
    expect(created.bodies).toEqual(["人間が書いた返答"]);
    expect(captured.options?.start.trigger).toEqual({
      commentId: createdCommentIds[0],
      command: false,
    });
  } finally {
    relay.stop();
  }
});

test("the confirm checkbox reaches the worker as an explicit command trigger", async () => {
  const relay = startFakeOwnershipRelay(deviceToken);
  const created = { bodies: [] as string[] };
  const { ports, createdCommentIds } = fakeLinearPorts(created);
  const captured: { options: StartHowConfirmationWorkerOptions | null } = {
    options: null,
  };

  try {
    await startHowConfirmationJob({
      ...baseOptions(relay.origin),
      trigger: { body: "HOWはこれで確定でお願いします", command: true },
      createLinearPorts: async () => ports,
      createWorker: fakeWorker(captured),
    });

    expect(captured.options?.start.trigger).toEqual({
      commentId: createdCommentIds[0],
      command: true,
    });
  } finally {
    relay.stop();
  }
});

test("an existing comment trigger is used as-is and posts no new comment", async () => {
  const relay = startFakeOwnershipRelay(deviceToken);
  const created = { bodies: [] as string[] };
  const { ports } = fakeLinearPorts(created);
  const captured: { options: StartHowConfirmationWorkerOptions | null } = {
    options: null,
  };

  try {
    await startHowConfirmationJob({
      ...baseOptions(relay.origin),
      trigger: { commentId: "comment-existing", command: true },
      createLinearPorts: async () => ports,
      createWorker: fakeWorker(captured),
    });

    expect(created.bodies).toEqual([]);
    expect(captured.options?.start.trigger).toEqual({
      commentId: "comment-existing",
      command: true,
    });
  } finally {
    relay.stop();
  }
});
