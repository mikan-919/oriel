import assert from "node:assert/strict";
import test from "node:test";
import { authenticator, client, connect, device, hostHeaders, origin, pair, runtime } from "./helpers.mjs";
import { workflowFixture } from "./workflow-fixture.mjs";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import * as capacity from "../src/workflow-capacity.ts";

test("HTTP discovery renews control ownership and final validation preserves pending notifications", () => {
  let now = 40000, schedules = 0;
  const c = vm.createContext({ ...capacity, Date: { now: () => now }, WebSocket: { OPEN: 1 } });
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/workflow-lease.ts", import.meta.url), "utf8"), { mode: "transform" });
  vm.runInContext(source.replace(/^import[\s\S]*?;/gm, "").replace(/^export /gm, "") + "\nglobalThis.WorkflowLeases = WorkflowLeases;", c);
  const device = { device_id: "device", user_id: "user", host_hash: "host", repository_generation: "revision" };
  const binding = { ...device, repository:{owner:"owner",name:"repo"}, github_generation:"github", linear_generation:"linear", repository_id:1, team_id:"team" };
  let saved = { protocol: "oriel/workflow/v2", binding, expires_at: 45000, grant: null, dirty: true };
  const ws = { readyState: 1, deserializeAttachment: () => structuredClone(saved), serializeAttachment: value => { saved = value; }, close() {} };
  const leases = Object.create(c.WorkflowLeases.prototype);
  leases.ctx = { getWebSockets: () => [ws], getWebSocketAutoResponseTimestamp: () => null };
  leases.integrations = { workflowBinding: () => binding };
  leases.device = () => device;
  leases.schedule = () => schedules++;
  leases.readScope(device, undefined, true);
  assert.equal(saved.expires_at, 85000);
  assert.equal(schedules, 1);
  saved.dirty = true;
  now = 60000;
  leases.readScope(device, undefined, false).check();
  assert.equal(saved.dirty, true);
  assert.equal(saved.expires_at, 85000);
  now = 85000;
  assert.throws(() => leases.readScope(device, undefined, false));
});

// Keep attachment storage and authority checks real; inject only socket I/O and
// account lookups, the boundaries supplied by the Durable Object in production.
function progressHarness() {
  const pending = [], controls = [], watchers = [];
  const devices = new Map(), bindings = new Map(), sessions = new Map();
  let duringHash = async () => {}, authorityFailure = false;
  class Socket {
    readyState = 1;
    saved = null;
    sent = [];
    failure = null;
    deserializeAttachment() { return structuredClone(this.saved); }
    serializeAttachment(value) {
      if (this.failure === "serializeAttachment" && value !== null) throw new Error("Attachment unavailable");
      this.saved = structuredClone(value);
    }
    send(value) {
      if (this.failure === "send") throw new Error("Browser disconnected");
      this.sent.push(JSON.parse(value));
    }
    close(code) { this.readyState = 3; this.code = code; }
  }
  const c = vm.createContext({ ...capacity, Date, TextEncoder, Uint8Array, crypto,
    WebSocket: { OPEN: 1 },
    WebSocketPair: class { constructor() { return [new Socket(), new Socket()]; } },
    Response: class { constructor(body, options) { Object.assign(this, options); } },
  });
  const workflow = stripTypeScriptTypes(readFileSync(new URL("../src/workflow.ts", import.meta.url), "utf8"), { mode: "transform" });
  // Load the production digest too, with a deterministic pause at its async boundary.
  const digestSource = workflow.slice(workflow.indexOf("export async function digest"), workflow.indexOf("export function validBranch"));
  vm.runInContext(digestSource.replace(/^export /gm, "") + "\nglobalThis.hashProgress = digest;", c);
  c.digest = async value => { const hash = await c.hashProgress(value); await duringHash(); return hash; };
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/workflow-lease.ts", import.meta.url), "utf8"), { mode: "transform" });
  vm.runInContext(source.replace(/^import[\s\S]*?;/gm, "").replace(/^export /gm, "") + "\nglobalThis.WorkflowLeases = WorkflowLeases;", c);
  const leases = new c.WorkflowLeases({
    getWebSockets: tag => tag === "workflow" ? controls : watchers,
    getWebSocketAutoResponseTimestamp: () => null,
    acceptWebSocket: ws => watchers.push(ws),
    waitUntil: promise => pending.push(promise),
  }, { workflowBinding: device => ({ ...bindings.get(device.device_id), user_id: device.user_id }) }, id => devices.get(id), userId => {
    if (authorityFailure) throw new Error("Account ownership could not be established");
    return [...devices.values()].filter(device => device.user_id === userId);
  }, (hash, userId) => sessions.get(`${userId}:${hash}`) ?? null, () => {});
  for (const [index, userId] of ["A", "B"].entries()) {
    const device = { device_id: `device-${userId}`, user_id: userId, host_hash: `host-${userId}`, repository_generation: "revision" };
    const binding = { ...device, repository: { owner: userId, name: "repo" }, github_generation: "github", linear_generation: "linear", repository_id: index + 1, team_id: `team-${userId}` };
    devices.set(device.device_id, device);
    bindings.set(device.device_id, binding);
    sessions.set(`${userId}:session`, Date.now() + 60_000);
    const ws = new Socket();
    ws.serializeAttachment({ protocol: "oriel/workflow/v2", binding, expires_at: Date.now() + 45_000,
      grant: { lease_id: `00000000-0000-4000-8000-00000000000${index}`, issue_number: 42 + index,
        task: { issue_number: 42 + index, title: `Private task ${userId}` } },
      stage: "implementing", task: null, updated_at: new Date().toISOString() });
    controls.push(ws);
  }
  return { leases, controls, watchers, devices, bindings, sessions,
    watch(userId) { leases.watch("session", userId); return watchers.at(-1); },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
    duringHash(callback) { duringHash = callback; },
    failAuthority() { authorityFailure = true; },
  };
}

for (const failure of ["send", "serializeAttachment"]) {
  test(`Progress ${failure} failure preserves both accounts' control grants and permits reconnect`, async () => {
    const h = progressHarness();
    const broken = h.watch("A"), healthy = h.watch("A"), foreign = h.watch("B");
    await h.drain();
    const saved = h.controls.map(ws => ws.deserializeAttachment());
    for (const ws of [broken, healthy, foreign]) ws.sent.length = 0;
    for (const ws of h.controls) ws.saved.stage = "reviewing";
    broken.failure = failure;
    h.leases.publish();
    await h.drain();
    assert.equal(broken.readyState, 3);
    assert.equal(broken.code, 1008);
    assert.equal(broken.saved, null);
    assert.equal(broken.sent.length, 0);
    for (const [index, ws] of h.controls.entries()) {
      assert.equal(ws.readyState, 1);
      assert.deepEqual(ws.saved.binding, saved[index].binding);
      assert.deepEqual(ws.saved.grant, saved[index].grant);
      const device = h.devices.get(ws.saved.binding.device_id);
      assert.equal(h.leases.verify(device, saved[index].grant.lease_id).lease_id, saved[index].grant.lease_id);
    }
    for (const [ws, userId] of [[healthy, "A"], [foreign, "B"]]) {
      assert.equal(ws.readyState, 1);
      assert.equal(ws.sent.length, 1);
      assert.equal(ws.sent[0].devices.length, 1);
      assert.equal(ws.sent[0].devices[0].device_id, `device-${userId}`);
      assert.equal(ws.sent[0].devices[0].stage, "reviewing");
      assert.equal(ws.sent[0].devices[0].task.repository, `${userId}/repo`);
    }
    const reconnected = h.watch("A");
    await h.drain();
    assert.deepEqual(reconnected.sent, healthy.sent);
    assert.equal(foreign.sent.length, 1, "Unchanged snapshots stay silent");
  });
}

for (const timing of ["before publish", "during hashing"]) {
  for (const change of ["session", "owner", "binding"]) {
    test(`Progress revalidates ${change} revocation ${timing}`, async () => {
      const h = progressHarness();
      const owner = h.watch("A"), foreign = h.watch("B");
      await h.drain();
      owner.sent.length = foreign.sent.length = 0;
      for (const ws of h.controls) ws.saved.stage = "reviewing";
      const revoke = () => {
        if (change === "session") h.sessions.set("A:session", Date.now() - 1);
        else if (change === "owner") h.devices.get("device-A").user_id = "B";
        else h.bindings.set("device-A", { ...h.bindings.get("device-A"), repository_generation: "revoked" });
      };
      if (timing === "before publish") revoke();
      else h.duringHash(revoke);
      h.leases.publish();
      await h.drain();
      assert.equal(foreign.readyState, 1);
      assert.equal(h.controls[1].readyState, 1);
      assert.ok(foreign.sent.length >= 1);
      assert.ok(foreign.sent.every(payload => payload.devices.every(device =>
        device.device_id !== "device-A" || device.state === "offline")), "B never receives A's private task");
      if (change === "session") {
        assert.equal(owner.readyState, 3);
        assert.equal(owner.sent.length, 0);
        assert.equal(h.controls[0].readyState, 1);
      } else {
        assert.equal(h.controls[0].readyState, 3);
        assert.equal(h.controls[0].saved, null);
        assert.equal(owner.sent.length, 1);
        assert.ok(owner.sent[0].devices.every(device => device.state === "offline" && device.task === null));
      }
    });
  }
}

test("Progress authority lookup exceptions retain the existing fail-closed stopAll policy", async () => {
  const h = progressHarness();
  h.watch("A");
  h.watch("B");
  await h.drain();
  h.failAuthority();
  h.leases.publish();
  await h.drain();
  for (const ws of [...h.controls, ...h.watchers]) {
    assert.equal(ws.readyState, 3);
    assert.equal(ws.saved, null);
  }
});

async function setup() {
  const fixture = workflowFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request), true);
  const paired = await pair(worker);
  await connect(paired.owner, fixture, "github");
  await connect(paired.owner, fixture, "linear");
  await paired.daemon.api(`/api/integrations/${device}/repository`, { repository: fixture.repository }, hostHeaders);
  fixture.addHow("Todo");
  return { ...paired, worker, fixture };
}

test("HOW collections avoid per-issue reads while preserving paginated link ambiguity", async () => {
  const s = await setup();
  try {
    for (let index = 0; index < 30; index++) {
      const how = s.fixture.addHow("Todo", 100 + index);
      how.id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      how.identifier = `ENG-${100 + index}`;
    }
    s.fixture.calls.length = 0;
    const snapshot = await s.owner.api(`/api/workflows/${device}`);
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.data));
    assert.equal(snapshot.data.workflows[0].phase, "approved");
    const calls = s.fixture.calls.filter(call => call.provider === "linear");
    assert.equal(calls.filter(call => call.operation === "hows").length, 2, "31 HOWs need two collection pages");
    assert.equal(calls.filter(call => call.operation === "how" && call.body.query.includes("attachments(")).length, 0,
      "HOW details come from the collection, not one query per HOW");

    // The matching link lies beyond the collection's first attachment page.
    const duplicate = s.fixture.addHow("Todo");
    duplicate.id = "22222222-2222-4222-8222-222222222222";
    duplicate.attachments.unshift(...Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}` })));
    s.fixture.attachmentPageSize = 2;
    const ambiguous = await s.owner.api(`/api/workflows/${device}`);
    assert.equal(ambiguous.status, 200, JSON.stringify(ambiguous.data));
    assert.equal(ambiguous.data.workflows[0].phase, "blocked");
    assert.match(ambiguous.data.workflows[0].blocked_reason, /Multiple Linear issues/);
  } finally { await s.worker.dispose(); }
});

test("Batched issue comments preserve later-page human requests and reject partial GraphQL data", async () => {
  const s = await setup();
  try {
    s.fixture.linears.length = 0;
    s.fixture.commentPageSize = 1;
    s.fixture.comments.set(42,[{id:1,body:"/oriel how",created_at:"2026-01-01T00:00:00Z",user:{type:"Bot",login:"bot"}},
      {id:2,body:"/oriel how",created_at:"2026-01-02T00:00:00Z",user:{type:"User",login:"human"}}]);
    const result = await s.owner.api(`/api/workflows/${device}`);
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(result.data.workflows[0].phase,"needs-how");
    assert.deepEqual(result.data.workflows[0].what_comments.map(comment=>comment.id),["1","2"]);
    s.fixture.commentGraphqlErrors = [{message:"private-provider-diagnostic"}];
    const failed = await s.owner.api(`/api/workflows/${device}`);
    assert.equal(failed.status,502);
    assert.doesNotMatch(JSON.stringify(failed.data),/private-provider-diagnostic/);
  } finally {await s.worker.dispose();}
});

test("Worker provider reads reject logout and provider changes before delivering a snapshot", async () => {
  const s = await setup();
  try {
    for (const change of ["logout", "disconnect"]) {
      let observed, release;
      const paused = new Promise(resolve => { release = resolve; });
      const reading = new Promise(resolve => { observed = resolve; });
      s.fixture.holdReads = async ({ operation }) => { if (operation === "repository") { observed(); await paused; } };
      const request = change === "logout" ? s.owner.api(`/api/workflows/${device}`) : s.daemon.api(`/api/workflows/${device}`, undefined, hostHeaders);
      await reading;
      if (change === "logout") await s.owner.api("/api/auth/logout", {});
      else {
        const options = await s.owner.api("/api/auth/login/options", {});
        await s.owner.api("/api/auth/login/verify", { credential: s.key.login(options.data.options) });
        await s.owner.api("/api/integrations/linear/disconnect", {});
      }
      release();
      const result = await request;
      assert.equal(result.status, change === "logout" ? 401 : 409, JSON.stringify(result.data));
      assert.ok(result.data.error);
      assert.ok(!JSON.stringify(result.data).includes("private-linear-access"));
      s.fixture.holdReads = null;
    }
    for (const path of ["/prepareSnapshot", "/finishSnapshot", "/terminal-change"]) {
      assert.equal((await s.worker.dispatchFetch(`${origin}${path}`, { method: "POST" })).status, 404);
    }
  } finally { await s.worker.dispose(); }
});

test("Account authority is invalidated on rollback and expires without another write", async () => {
  const s = await setup();
  try {
    const namespace = await s.worker.getDurableObjectNamespace("ACCOUNTS");
    const account = namespace.get(namespace.idFromName("accounts"));
    const original = (await account.accountSqlForTest("SELECT * FROM devices WHERE device_id = ?", [device]))[0];
    assert.equal(await account.rollbackForTest("UPDATE devices SET user_id = ? WHERE device_id = ?", ["foreign", device],
      "SELECT * FROM devices WHERE device_id = ?", [device]), true);
    assert.deepEqual((await account.accountSqlForTest("SELECT * FROM devices WHERE device_id = ?", [device]))[0], original);
    assert.equal((await s.daemon.api(`/api/workflows/${device}`, undefined, hostHeaders)).status, 200);
    await account.shortenSessionsForTest();
    assert.equal((await s.owner.api("/api/session")).data.user.id, s.user.id);
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal((await s.owner.api("/api/session")).data.user, null);
  } finally { await s.worker.dispose(); }
});

test("Snapshot transport advertises HTTP and refuses unowned or malformed scoped reads", async () => {
  const s = await setup();
  try {
    const response = await s.worker.dispatchFetch(`${origin}/api/workflows/${device}/connect`, { headers: { ...hostHeaders, Upgrade: "websocket" } });
    assert.equal(response.headers.get("X-Oriel-Snapshot-Transport"), "http");
    assert.equal(response.headers.get("X-Oriel-Verification"), "1");
    response.webSocket.accept();
    assert.equal((await s.daemon.api(`/api/workflows/${device}/snapshot`, {}, hostHeaders)).status, 200);
    assert.equal((await s.daemon.api(`/api/workflows/${device}/snapshot`, { lease_id: "forged" }, hostHeaders)).status, 409);
    assert.equal((await s.daemon.api(`/api/workflows/${device}/snapshot`, { issue_number: 42 }, hostHeaders)).status, 400);
    assert.equal((await s.owner.api(`/api/workflows/${device}/snapshot`, {})).status, 403);
    const foreign = client(s.worker);
    await foreign.enroll(authenticator());
    assert.equal((await foreign.api(`/api/workflows/${device}`)).status, 403);
    response.webSocket.close();
  } finally { await s.worker.dispose(); }
});
