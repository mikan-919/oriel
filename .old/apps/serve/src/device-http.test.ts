import { expect, test } from "bun:test";

import type { DeviceRegistrationFlow } from "./device-registration";
import { createJobRegistry, holdIfStarted } from "./job-registry";
import { startServeHttpServer, type StartedIssueConversation } from "./server";

const installationId = 7;
const repositoryId = 11;

function fakeFlow(overrides: Partial<DeviceRegistrationFlow> = {}) {
  const completed: string[] = [];
  const started: Record<string, unknown>[] = [];
  const flow = {
    begin: (input: Record<string, unknown>) => {
      started.push(input);
      return {
        authorizeUrl: new URL(
          `https://relay.test/device/authorize?p=${String(input.purpose)}`,
        ),
      };
    },
    complete: async (callbackUrl: URL | string) => {
      completed.push(String(callbackUrl));
      return { status: "registered" as const, deviceId: "device-1" };
    },
    pendingCancellations: () => [],
    resumePendingCancellations: async () => [],
    ...overrides,
  } as unknown as DeviceRegistrationFlow;

  return { flow, completed, started };
}

function startServer(
  flow: DeviceRegistrationFlow,
  startIssueConversation?: (input: {
    issueNumber: number;
    body: string;
  }) => Promise<StartedIssueConversation | { status: string; reason?: string }>,
  startImplementationJob?: (input: {
    linearIssueId: string;
  }) => Promise<StartedIssueConversation | { status: string; reason?: string }>,
) {
  const jobRegistry = createJobRegistry();
  const server = startServeHttpServer({
    createDeviceRegistration: () => flow,
    jobRegistry,
    startIssueConversation:
      startIssueConversation === undefined
        ? undefined
        : async (input) =>
            holdIfStarted(
              jobRegistry,
              "issue_conversation",
              await startIssueConversation(input),
            ),
    startImplementationJob:
      startImplementationJob === undefined
        ? undefined
        : async (input) =>
            holdIfStarted(
              jobRegistry,
              "implementation",
              await startImplementationJob(input),
            ),
  });

  return {
    ...server,
    origin: new URL(server.readinessUrl).origin,
    close: () => server.close(),
  };
}

async function openShell(origin: string) {
  const response = await fetch(`${origin}/`, { headers: { Origin: origin } });
  const html = await response.text();
  const cookie = response.headers.get("set-cookie") ?? "";

  return {
    response,
    html,
    cookie,
    session: cookie.split(";")[0] ?? "",
    csrf: /content="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

test("the localhost shell sets a per-start session cookie and hands out a CSRF token", async () => {
  const { flow } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);

    expect(shell.response.status).toBe(200);
    expect(shell.cookie).toContain("HttpOnly");
    expect(shell.cookie).toContain("SameSite=Strict");
    expect(shell.cookie).toContain("Path=/");
    expect(shell.cookie).not.toContain("Max-Age");
    expect(shell.cookie).not.toContain("Expires");
    expect(shell.csrf).not.toBe("");
    expect(
      shell.response.headers.get("access-control-allow-origin"),
    ).toBeNull();
    expect(shell.response.headers.get("x-frame-options")).toBe("DENY");
  } finally {
    server.close();
  }
});

test("the web UI session endpoint hands out a session and a CSRF token without device registration", async () => {
  const server = startServer(undefined as unknown as DeviceRegistrationFlow);

  try {
    const response = await fetch(`${server.origin}/app/session`, {
      headers: { Origin: server.origin },
    });
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const body = (await response.json()) as { csrfToken: string };

    expect(body.csrfToken).not.toBe("");
  } finally {
    server.close();
  }
});

test("state changing requests need the session cookie, the CSRF header, and a same-origin Origin", async () => {
  const { flow } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);
    const body = JSON.stringify({
      purpose: "registration",
      installationId,
      repositoryId,
    });
    const post = (headers: Record<string, string>) =>
      fetch(`${server.origin}/api/device-registrations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });

    expect((await post({ Origin: server.origin })).status).toBe(403);
    expect(
      (await post({ Origin: server.origin, cookie: shell.session })).status,
    ).toBe(403);
    expect(
      (
        await post({
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": "forged",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post({
          Origin: "http://forged.invalid",
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        })
      ).status,
    ).toBe(400);

    const accepted = await post({
      Origin: server.origin,
      cookie: shell.session,
      "x-oriel-csrf": shell.csrf,
    });

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      authorizeUrl: "https://relay.test/device/authorize?p=registration",
    });
  } finally {
    server.close();
  }
});

test("the relay callback is a plain GET that changes nothing until the UI posts it back", async () => {
  const { flow, completed } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);
    const callback = await fetch(
      `${server.origin}/device/callback?code=one-time&state=state-1`,
      { headers: { Origin: server.origin } },
    );

    expect(callback.status).toBe(200);
    expect(completed).toEqual([]);

    const completion = await fetch(
      `${server.origin}/api/device-registrations/completion`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
        body: JSON.stringify({ code: "one-time", state: "state-1" }),
      },
    );

    expect(completion.status).toBe(200);
    expect(await completion.json()).toEqual({
      status: "registered",
      deviceId: "device-1",
    });
    expect(completed).toHaveLength(1);
    expect(new URL(completed[0] ?? "").searchParams.get("code")).toBe(
      "one-time",
    );
  } finally {
    server.close();
  }
});

test("the UI starts a fresh GitHub login for listing and for each revocation", async () => {
  const { flow, started } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);
    const post = (body: unknown) =>
      fetch(`${server.origin}/api/device-registrations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
        body: JSON.stringify(body),
      });

    expect((await post({ purpose: "installations" })).status).toBe(200);
    expect(
      (
        await post({
          purpose: "device_list",
          installationId,
          repositoryId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post({
          purpose: "revocation",
          installationId,
          repositoryId,
          deviceId: "device-1",
        })
      ).status,
    ).toBe(200);

    // 失効にはdeviceの指定が要る。IDだけの手入力経路は無い。
    expect(
      (await post({ purpose: "revocation", installationId, repositoryId }))
        .status,
    ).toBe(400);
    expect((await post({ purpose: "registration" })).status).toBe(400);
    expect((await post({ purpose: "unknown" })).status).toBe(400);

    expect(started).toEqual([
      {
        purpose: "installations",
        installationId: 0,
        repositoryId: 0,
        deviceId: undefined,
      },
      {
        purpose: "device_list",
        installationId,
        repositoryId,
        deviceId: undefined,
      },
      {
        purpose: "revocation",
        installationId,
        repositoryId,
        deviceId: "device-1",
      },
    ]);
  } finally {
    server.close();
  }
});

test("the shell offers GitHub installation choices instead of typed IDs", async () => {
  const { flow } = fakeFlow();
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);

    expect(shell.html).toContain("GitHubのinstallation");
    expect(shell.html).toContain('id="targets"');
    expect(shell.html).not.toContain('name="installationId"');
  } finally {
    server.close();
  }
});

test("held cancellations are reported and can be resumed from the localhost UI", async () => {
  const pending = [
    {
      deviceId: "device-1",
      cancellationToken: "cancellation",
      cancellationExpiresAt: 2_000,
    },
  ];
  const { flow } = fakeFlow({
    pendingCancellations: () => pending,
    resumePendingCancellations: async () => pending,
  });
  const server = startServer(flow);

  try {
    const shell = await openShell(server.origin);
    const listed = await fetch(`${server.origin}/api/device-cancellations`, {
      headers: { Origin: server.origin, cookie: shell.session },
    });

    expect(await listed.json()).toEqual({ pending });

    const resumed = await fetch(
      `${server.origin}/api/device-cancellations/resume`,
      {
        method: "POST",
        headers: {
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
      },
    );

    expect(await resumed.json()).toEqual({ pending });
  } finally {
    server.close();
  }
});

test("the Issue conversation entry takes no Job key or code changing input", async () => {
  const requests: { issueNumber: number; body: string }[] = [];
  const { flow } = fakeFlow();
  const server = startServer(flow, async (input) => {
    requests.push(input);
    return fakeConversation(`job-${input.issueNumber}`).handle;
  });

  try {
    const shell = await openShell(server.origin);
    const post = (body: unknown) =>
      fetch(`${server.origin}/api/issue-conversations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
        body: JSON.stringify(body),
      });

    expect((await post({ issueNumber: 28, body: "reply" })).status).toBe(200);
    // clientはJobキーを指定できず、コードを変更するJobも起動できない。
    expect(
      (await post({ issueNumber: 28, body: "reply", canonicalBranch: "x" }))
        .status,
    ).toBe(400);
    expect((await post({ issueNumber: 28 })).status).toBe(400);
    expect((await post({ issueNumber: 0, body: "reply" })).status).toBe(400);
    // 実装Jobの入力は対話の入口では受け付けない。
    expect(
      (await post({ issueNumber: 28, body: "reply", linearIssueId: "ENG-12" }))
        .status,
    ).toBe(400);
    expect(requests).toEqual([{ issueNumber: 28, body: "reply" }]);

    expect((await post({ issueNumber: 29, body: "reply" })).status).toBe(200);
  } finally {
    server.close();
  }
});

test("a refused conversation answers with a conflict and starts nothing", async () => {
  const { flow } = fakeFlow();
  const server = startServer(flow, async () => ({
    status: "refused",
    reason: "github_credentials_unavailable",
  }));

  try {
    const shell = await openShell(server.origin);
    const response = await fetch(`${server.origin}/api/issue-conversations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: server.origin,
        cookie: shell.session,
        "x-oriel-csrf": shell.csrf,
      },
      body: JSON.stringify({ issueNumber: 28, body: "reply" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      status: "refused",
      reason: "github_credentials_unavailable",
    });
  } finally {
    server.close();
  }
});

/** 開始できたJobのふるまいをHTTP境界から観察するためのfake。 */
function fakeConversation(jobId: string) {
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
    handle: {
      status: "started" as const,
      jobId,
      finished,
      jobStatus: () => state.status,
      close: () => {
        state.closed = true;
      },
    },
  };
}

test("a started conversation is held, driven to completion, and cleaned up", async () => {
  const conversation = fakeConversation("job-1");
  const { flow } = fakeFlow();
  const server = startServer(flow, async () => conversation.handle);

  try {
    const shell = await openShell(server.origin);
    const started = await fetch(`${server.origin}/api/issue-conversations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: server.origin,
        cookie: shell.session,
        "x-oriel-csrf": shell.csrf,
      },
      body: JSON.stringify({ issueNumber: 28, body: "reply" }),
    });

    expect(await started.json()).toEqual({ status: "started", jobId: "job-1" });

    const active = await fetch(`${server.origin}/api/jobs`, {
      headers: { Origin: server.origin, cookie: shell.session },
    });

    expect(await active.json()).toEqual({
      jobs: [{ jobId: "job-1", kind: "issue_conversation", status: "running" }],
    });
    expect(conversation.state.closed).toBe(false);

    conversation.finish();
    await Bun.sleep(20);

    // 正常終了でlease、heartbeat、runtime、processを片付ける。
    expect(conversation.state.closed).toBe(true);
    expect(conversation.state.status).toBe("completed");

    const afterCompletion = await fetch(`${server.origin}/api/jobs`, {
      headers: { Origin: server.origin, cookie: shell.session },
    });

    expect(await afterCompletion.json()).toEqual({ jobs: [] });
  } finally {
    server.close();
  }
});

test("shutting down closes the Jobs that are still running", async () => {
  const conversation = fakeConversation("job-1");
  const { flow } = fakeFlow();
  const server = startServer(flow, async () => conversation.handle);
  const shell = await openShell(server.origin);

  await fetch(`${server.origin}/api/issue-conversations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: server.origin,
      cookie: shell.session,
      "x-oriel-csrf": shell.csrf,
    },
    body: JSON.stringify({ issueNumber: 28, body: "reply" }),
  });

  expect(conversation.state.closed).toBe(false);

  server.close();

  expect(conversation.state.closed).toBe(true);
});

test("the implementation Job entry takes only the approved Linear issue", async () => {
  const conversations: unknown[] = [];
  const implementations: { linearIssueId: string }[] = [];
  const { flow } = fakeFlow();
  const server = startServer(
    flow,
    async (input) => {
      conversations.push(input);
      return fakeConversation("conversation-1").handle;
    },
    async (input) => {
      implementations.push(input);
      return fakeConversation("implementation-1").handle;
    },
  );

  try {
    const shell = await openShell(server.origin);
    const post = (body: unknown) =>
      fetch(`${server.origin}/api/implementation-jobs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: server.origin,
          cookie: shell.session,
          "x-oriel-csrf": shell.csrf,
        },
        body: JSON.stringify(body),
      });
    const started = await post({ linearIssueId: "ENG-12" });

    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({
      status: "started",
      jobId: "implementation-1",
    });

    // WHAT、Jobキー、ブランチ、作業内容はclientから受け取らない。
    for (const rejected of [
      {},
      { linearIssueId: "" },
      { linearIssueId: "ENG-12", issueNumber: 28 },
      { linearIssueId: "ENG-12", body: "go" },
      { linearIssueId: "ENG-12", canonicalBranch: "attacker/branch" },
      { linearIssueId: "ENG-12", jobId: "attacker-job" },
      { linearIssueId: "ENG-12", approvalFingerprint: "0".repeat(64) },
    ]) {
      expect((await post(rejected)).status).toBe(400);
    }

    expect(implementations).toEqual([{ linearIssueId: "ENG-12" }]);
    // 対話の起動経路とは混ぜない。
    expect(conversations).toEqual([]);

    const active = await fetch(`${server.origin}/api/jobs`, {
      headers: { Origin: server.origin, cookie: shell.session },
    });

    expect(await active.json()).toEqual({
      jobs: [
        {
          jobId: "implementation-1",
          kind: "implementation",
          status: "running",
        },
      ],
    });
  } finally {
    server.close();
  }
});

test("the implementation Job entry is closed while the product cannot run one", async () => {
  const { flow } = fakeFlow();
  const server = startServer(
    flow,
    async () => fakeConversation("job-1").handle,
  );

  try {
    const shell = await openShell(server.origin);
    const response = await fetch(`${server.origin}/api/implementation-jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: server.origin,
        cookie: shell.session,
        "x-oriel-csrf": shell.csrf,
      },
      body: JSON.stringify({ linearIssueId: "ENG-12" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "not_configured",
      message: expect.stringContaining("ORIEL_MODEL_PROVIDER"),
    });
  } finally {
    server.close();
  }
});
