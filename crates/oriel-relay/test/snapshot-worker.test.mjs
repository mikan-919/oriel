import assert from "node:assert/strict";
import test from "node:test";
import { authenticator, client, connect, device, hostHeaders, origin, pair, runtime } from "./helpers.mjs";
import { workflowFixture } from "./workflow-fixture.mjs";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

test("HTTP discovery renews control ownership and final validation preserves pending notifications", () => {
  let now = 40000, schedules = 0;
  const c = vm.createContext({ Date: { now: () => now }, WebSocket: { OPEN: 1 } });
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
