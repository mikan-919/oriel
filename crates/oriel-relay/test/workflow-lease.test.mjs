import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { origin, device, hostToken, hostHeaders, authenticator, runtime, client, pair, connect } from "./helpers.mjs";
import { workflowFixture } from "./workflow-fixture.mjs";

const secondDevice = "d".repeat(32);
const secondToken = "e".repeat(64);
const secondHeaders = { Authorization: `Bearer ${secondToken}` };

function bounded(promise, milliseconds = 10_000, label = "Workflow lifecycle operation") {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function addDevice(owner, daemon, user, id, token) {
  const headers = { Authorization: `Bearer ${token}` };
  const started = await daemon.api("/api/pair/start", { device_id: id, name: `workflow-${id[0]}` }, headers);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal((await owner.api("/api/pair/claim", { token: new URL(started.data.url).hash.slice(6) })).status, 200);
  assert.equal((await daemon.api(`/api/pair/${id}/confirm`, { user_id: user.id }, headers)).status, 200);
  assert.equal((await daemon.api(`/api/integrations/${id}/repository`, {
    repository: { owner: "octocat", name: "connected" },
  }, headers)).status, 200);
}

async function setup(fixture) {
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  const paired = await pair(worker);
  for (const provider of ["github", "linear"]) await connect(paired.owner, fixture, provider);
  assert.equal((await paired.daemon.api(`/api/integrations/${device}/repository`, {
    repository: { owner: "octocat", name: "connected" },
  }, hostHeaders)).status, 200);
  return { worker, ...paired };
}

async function socket(worker, id = device, token = hostToken, headers = {}) {
  const response = await worker.dispatchFetch(`${origin}/api/workflows/${id}/connect`, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}`, ...headers },
  });
  assert.equal(response.status, 101);
  const ws = response.webSocket;
  ws.accept();
  const pending = new Map();
  const unsolicited = [];
  let unmatched;
  let closed = false;
  let closeEvent;
  const ended = new Promise(resolve => { closeEvent = resolve; });
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.request_id);
    if (resolve) { pending.delete(message.request_id); resolve(message); }
    else if (unmatched) { const receive = unmatched; unmatched = null; receive(message); }
    else unsolicited.push(message);
  });
  ws.addEventListener("close", event => {
    closed = true;
    for (const resolve of pending.values()) resolve({ type: "closed", code: event.code });
    pending.clear();
    closeEvent(event);
  });
  return {
    ws, unsolicited, ended,
    receive() {
      if (unsolicited.length) return Promise.resolve(unsolicited.shift());
      return bounded(new Promise(resolve => { unmatched = resolve; }));
    },
    rpc(request) {
      assert.equal(closed, false, "Cannot use a closed workflow socket");
      const request_id = randomUUID();
      const result = new Promise(resolve => pending.set(request_id, resolve));
      ws.send(JSON.stringify({ ...request, request_id }));
      return bounded(result);
    },
    close() { ws.close(1000, "Finished"); },
  };
}

async function watch(worker, owner) {
  const response = await worker.dispatchFetch(`${origin}/api/workflow-progress/connect`, {
    headers: { Upgrade: "websocket", Origin: origin,
      Cookie: [...owner.cookies].map(([key, value]) => `${key}=${value}`).join("; ") },
  });
  assert.equal(response.status, 101);
  const ws = response.webSocket;
  const frames = [];
  let receive;
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  ws.addEventListener("message", event => {
    const frame = JSON.parse(event.data);
    assert.deepEqual(Object.keys(frame).sort(), ["devices", "type"]);
    assert.equal(frame.type, "workflow-progress");
    for (const device of frame.devices) {
      assert.deepEqual(Object.keys(device).sort(), ["device_id", "stage", "state", "task", "updated_at"]);
      if (device.task) assert.deepEqual(Object.keys(device.task).sort(),
        ["how_identifier", "how_url", "issue_number", "repository", "title", "url"]);
    }
    if (receive) { const resolve = receive; receive = null; resolve(frame); }
    else frames.push(frame);
  });
  ws.addEventListener("close", event => { finish(event); });
  ws.accept();
  ws.send("ready");
  return {
    ws, frames, ended,
    snapshot(matches = () => true, milliseconds = 10_000) {
      return bounded((async () => {
        for (;;) {
          const frame = frames.length ? frames.shift() : await new Promise(resolve => { receive = resolve; });
          if (matches(frame.devices)) return frame;
        }
      })(), milliseconds);
    },
  };
}

function progressDevice(frame, id = device) {
  const current = frame.devices.find(current => current.device_id === id);
  assert.ok(current, "Owned paired devices must remain visible");
  return current;
}

test("Owner progress streams follow multiple devices, admitted task metadata, pauses and reconnects", { timeout: 60_000 }, async () => {
  const fixture = workflowFixture();
  const how = fixture.addHow("Todo");
  fixture.issues[0].title = "切断デバイス".repeat(32);
  how.url += "/切断しても登録を保持して復帰後に再接続する";
  fixture.issues.push({ ...fixture.issues[0], number: 43, node_id: "I_43", title: "A second WHAT",
    html_url: "https://github.com/octocat/connected/issues/43" });
  fixture.feedback(43, "@oriel-relay[bot] how");
  const { worker, owner, daemon, user } = await setup(fixture);
  try {
    await addDevice(owner, daemon, user, secondDevice, secondToken);
    const observer = await watch(worker, owner);
    const initial = await observer.snapshot();
    assert.deepEqual(initial.devices.map(({ device_id }) => device_id).sort(), [device, secondDevice].sort());
    assert.deepEqual(progressDevice(initial), { device_id: device, state: "offline", stage: null, task: null, updated_at: null });
    const first = await socket(worker);
    const second = await socket(worker, secondDevice, secondToken);
    assert.equal(progressDevice(await observer.snapshot(devices => devices.every(current => current.state === "idle"))).task, null);
    assert.equal((await second.rpc({ type: "progress", stage: "implementing" })).type, "rejected");
    assert.equal((await second.rpc({ type: "progress", stage: "stdout" })).type, "rejected");
    assert.equal((await second.rpc({ type: "progress", stage: "discovering", task: { title: "Forged" } })).type, "rejected");
    assert.equal((await second.rpc({ type: "progress", stage: "discovering" })).type, "progressed");
    const discovering = progressDevice(await observer.snapshot(devices =>
      devices.find(current => current.device_id === secondDevice)?.stage === "discovering"), secondDevice);
    assert.equal(discovering.state, "running");
    assert.equal(discovering.task, null);
    const current = await row(daemon);
    const granted = await first.rpc({ ...claim(current, "implement"),
      task: { title: "Forged model title", url: "https://evil.example", repository: "foreign/private" } });
    assert.equal(granted.type, "granted");
    const admitted = progressDevice(await observer.snapshot(devices =>
      devices.find(current => current.device_id === device)?.stage === "preparing"));
    assert.equal(admitted.state, "running");
    assert.deepEqual(admitted.task, { repository: "octocat/connected", issue_number: 42, title: fixture.issues[0].title,
      url: fixture.issues[0].html_url, how_identifier: how.identifier, how_url: how.url });
    assert.equal(Number.isFinite(Date.parse(admitted.updated_at)), true);
    assert.equal((await first.rpc({ type: "progress", stage: "implementing" })).type, "rejected");
    assert.equal((await first.rpc({ type: "progress", stage: "idle", lease_id: randomUUID() })).type, "rejected");
    assert.equal((await second.rpc({ type: "progress", stage: "planning", lease_id: granted.lease_id })).type, "rejected");
    const secondSnapshot = await daemon.api(`/api/workflows/${secondDevice}`, undefined, secondHeaders);
    assert.equal(secondSnapshot.status, 200, JSON.stringify(secondSnapshot.data));
    const secondGrant = await second.rpc(claim(secondSnapshot.data.workflows.find(row => row.issue.number === 43)));
    assert.equal(secondGrant.type, "granted");
    assert.equal((await second.rpc({ type: "progress", stage: "planning", lease_id: secondGrant.lease_id })).type, "progressed");
    assert.equal((await first.rpc({ type: "progress", stage: "verifying", lease_id: granted.lease_id })).type, "progressed");
    const concurrent = await observer.snapshot(devices => devices.find(current => current.device_id === device)?.stage === "verifying" &&
      devices.find(current => current.device_id === secondDevice)?.stage === "planning");
    assert.equal(progressDevice(concurrent).task.issue_number, 42);
    assert.deepEqual(progressDevice(concurrent, secondDevice).task, { repository: "octocat/connected", issue_number: 43,
      title: "A second WHAT", url: fixture.issues[1].html_url, how_identifier: null, how_url: null });
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.equal((await first.rpc({ type: "progress", stage: "paused", lease_id: granted.lease_id })).type, "progressed");
    assert.equal((await first.rpc({ type: "release", lease_id: granted.lease_id })).type, "released");
    assert.equal((await gitToken(daemon, granted.lease_id)).status, 409);
    const paused = progressDevice(await observer.snapshot(devices => devices.find(current => current.device_id === device)?.state === "paused"));
    assert.deepEqual(paused.task, admitted.task);
    assert.equal((await first.rpc({ type: "progress", stage: "paused" })).type, "progressed");
    assert.equal((await first.rpc({ type: "progress", stage: "discovering" })).type, "progressed");
    assert.equal(progressDevice(await observer.snapshot(devices =>
      devices.find(current => current.device_id === device)?.stage === "discovering")).task, null);
    const reclaim = await first.rpc(claim(current, "implement"));
    assert.equal(reclaim.type, "granted");
    assert.equal(progressDevice(await observer.snapshot(devices =>
      devices.find(current => current.device_id === device)?.stage === "preparing")).task.issue_number, 42);
    assert.equal((await second.rpc({ type: "release", lease_id: secondGrant.lease_id })).type, "released");
    const released = progressDevice(await observer.snapshot(devices =>
      devices.find(current => current.device_id === secondDevice)?.state === "idle"), secondDevice);
    assert.equal(released.task, null);
    const replacement = await socket(worker);
    assert.equal((await bounded(first.ended)).code, 1008);
    assert.equal((await gitToken(daemon, reclaim.lease_id)).status, 409);
    assert.equal(progressDevice(await observer.snapshot(devices =>
      devices.find(current => current.device_id === device)?.state === "idle")).task, null);
    replacement.close();
    await bounded(replacement.ended);
    assert.deepEqual(progressDevice(await observer.snapshot(devices =>
      devices.find(current => current.device_id === device)?.state === "offline")),
      { device_id: device, state: "offline", stage: null, task: null, updated_at: null });
  } finally { await worker.dispose(); }
});

test("Progress upgrades isolate foreign owners and browser frames cannot acquire control authority", { timeout: 60_000 }, async () => {
  const fixture = workflowFixture();
  const { worker, owner, daemon } = await setup(fixture);
  try {
    const cookies = [...owner.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    for (const [headers, expected] of [
      [{ Upgrade: "websocket", Origin: origin }, 401],
      [{ Upgrade: "websocket", Cookie: cookies }, 403],
      [{ Upgrade: "websocket", Origin: "https://evil.example", Cookie: cookies }, 403],
      [{ Upgrade: "websocket", Origin: origin, Cookie: cookies, ...hostHeaders }, 403],
    ]) {
      assert.equal((await worker.dispatchFetch(`${origin}/api/workflow-progress/connect`, { headers })).status, expected);
    }
    assert.equal((await worker.dispatchFetch(`${origin}/api/workflow-progress/connect?device_id=${device}`, {
      headers: { Upgrade: "websocket", Origin: origin, Cookie: cookies },
    })).status, 400);
    const stranger = client(worker);
    const foreign = await stranger.enroll(authenticator());
    await addDevice(stranger, daemon, foreign, secondDevice, secondToken);
    const other = await watch(worker, stranger);
    assert.deepEqual((await other.snapshot()).devices,
      [{ device_id: secondDevice, state: "offline", stage: null, task: null, updated_at: null }]);
    const observer = await watch(worker, owner);
    await observer.snapshot();
    const host = await socket(worker);
    const granted = await host.rpc(claim(await row(daemon)));
    assert.equal(granted.type, "granted");
    assert.equal(progressDevice(await observer.snapshot(devices => devices[0]?.task?.issue_number === 42)).state, "running");
    assert.deepEqual((await other.snapshot()).devices,
      [{ device_id: secondDevice, state: "offline", stage: null, task: null, updated_at: null }]);
    other.ws.send(JSON.stringify({ type: "claim", request_id: randomUUID(), issue_number: 42, kind: "plan" }));
    assert.equal((await bounded(other.ended)).code, 1008);
    assert.equal((await host.rpc({ type: "check", lease_id: granted.lease_id })).type, "checked");
    const foreignObserver = await watch(worker, stranger);
    await foreignObserver.snapshot();
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    await storage.exec("UPDATE devices SET user_id = ? WHERE device_id = ?", foreign.id, device);
    await host.rpc({ type: "heartbeat" });
    assert.equal((await bounded(host.ended)).code, 1008);
    assert.deepEqual((await observer.snapshot(devices => devices.length === 0)).devices, []);
    const transferred = await foreignObserver.snapshot(devices => devices.some(current => current.device_id === device));
    assert.deepEqual(progressDevice(transferred), { device_id: device, state: "offline", stage: null, task: null, updated_at: null });
    assert.equal((await gitToken(daemon, granted.lease_id)).status, 409);
  } finally { await worker.dispose(); }
});

test("Logout and session replacement revoke only their read-only progress stream, not host authority", { timeout: 60_000 }, async () => {
  const fixture = workflowFixture();
  const { worker, owner, daemon, key } = await setup(fixture);
  try {
    const host = await socket(worker);
    const granted = await host.rpc(claim(await row(daemon)));
    assert.equal(granted.type, "granted");
    const observer = await watch(worker, owner);
    await observer.snapshot();
    const independent = client(worker);
    let options = await independent.api("/api/auth/login/options", {});
    assert.equal((await independent.api("/api/auth/login/verify", { credential: key.login(options.data.options) })).status, 200);
    const other = await watch(worker, independent);
    await other.snapshot();
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.equal((await owner.api("/api/auth/logout", {})).status, 200);
    assert.equal((await bounded(observer.ended, 10_000, "Logged-out watcher closure")).code, 1008);
    assert.equal((await host.rpc({ type: "progress", stage: "planning", lease_id: granted.lease_id })).type, "progressed");
    assert.equal(progressDevice(await other.snapshot(devices => devices[0]?.stage === "planning")).task.issue_number, 42);
    options = await independent.api("/api/auth/login/options", {});
    assert.equal((await independent.api("/api/auth/login/verify", { credential: key.login(options.data.options) })).status, 200);
    assert.equal((await bounded(other.ended, 10_000, "Replaced session watcher closure")).code, 1008);
    const refreshed = await watch(worker, independent);
    assert.equal(progressDevice(await refreshed.snapshot()).stage, "planning");
    assert.equal((await host.rpc({ type: "check", lease_id: granted.lease_id })).type, "checked");
    const denied = await worker.dispatchFetch(`${origin}/api/workflow-progress/connect`, {
      headers: { Upgrade: "websocket", Origin: origin,
        Cookie: [...owner.cookies].map(([key, value]) => `${key}=${value}`).join("; ") },
    });
    assert.equal(denied.status, 401);
  } finally { await worker.dispose(); }
});

test("Progress watch expiry closes a silent session at its deadline while leaving the host lease live", { timeout: 60_000 }, async () => {
  const fixture = workflowFixture();
  const { worker, owner, daemon, user } = await setup(fixture);
  try {
    const host = await socket(worker);
    const granted = await host.rpc(claim(await row(daemon)));
    const observer = await watch(worker, owner);
    assert.equal(progressDevice(await observer.snapshot()).task.issue_number, 42);
    assert.equal((await host.rpc({ type: "progress", stage: "planning", lease_id: granted.lease_id })).type, "progressed");
    assert.equal(progressDevice(await observer.snapshot(devices => devices[0]?.stage === "planning")).task.issue_number, 42);
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    await storage.exec("UPDATE sessions SET expires_at = ? WHERE user_id = ?", Math.floor(Date.now() / 1000) + 3, user.id);
    assert.equal((await host.rpc({ type: "heartbeat" })).type, "heartbeat");
    assert.equal((await bounded(observer.ended, 8_000, "Expired watcher closure")).code, 1008);
    assert.equal((await host.rpc({ type: "check", lease_id: granted.lease_id })).type, "checked");
    assert.equal((await owner.api("/api/session")).data.user, null);
  } finally { await worker.dispose(); }
});

async function row(daemon, id = device, headers = hostHeaders) {
  const snapshot = await daemon.api(`/api/workflows/${id}`, undefined, headers);
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.data));
  const current = snapshot.data.workflows.find(workflow => workflow.issue.number === 42);
  assert.ok(current, "Current WHAT must remain discoverable");
  return current;
}

function claim(current, kind = "plan") {
  return { type: "claim", kind, issue_number: current.issue.number, version: current.version, branch: current.branch };
}

function gitToken(daemon, lease_id, id = device, headers = hostHeaders) {
  return daemon.api(`/api/workflows/${id}/git-token`, { lease_id }, headers);
}

test("Workflow routing uses host authority without browser fallback and never carries terminal frames", { timeout: 60_000 }, async () => {
  const fixture = workflowFixture();
  const { worker, owner, daemon } = await setup(fixture);
  try {
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    assert.equal((await owner.api(`/api/workflows/${device}`)).status, 200);
    assert.equal((await stranger.api(`/api/workflows/${device}`)).status, 403);
    assert.equal((await owner.api(`/api/workflows/${device}`, undefined, { Authorization: "Bearer invalid" })).status, 401);
    assert.equal((await owner.api(`/api/workflows/${device}`, undefined, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await owner.api(`/api/workflows/${device}/issues`, {
      title: "WHAT", body: "Needs human approval", request_id: randomUUID(),
    }, { Origin: "https://evil.example" })).status, 403);
    const cookies = [...owner.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    for (const [headers, expected] of [
      [{ Upgrade: "websocket", Cookie: cookies, Origin: origin }, 401],
      [{ Upgrade: "websocket", Cookie: cookies, Authorization: "Bearer invalid" }, 401],
      [{ Upgrade: "websocket", Authorization: `Bearer ${"f".repeat(64)}` }, 403],
      [hostHeaders, 400],
    ]) {
      assert.equal((await worker.dispatchFetch(`${origin}/api/workflows/${device}/connect`, { headers })).status, expected);
    }
    assert.equal((await worker.dispatchFetch(`${origin}/api/workflows/${device}/connect?token=secret`, {
      headers: { ...hostHeaders, Upgrade: "websocket" },
    })).status, 400);
    assert.equal((await worker.dispatchFetch(`${origin}/api/workflows/${device}/connect`, {
      method: "POST", headers: hostHeaders,
    })).status, 400);
    const connection = await socket(worker, device, hostToken, { Origin: "https://daemon.invalid" });
    const current = await row(daemon);
    assert.equal((await connection.rpc({ ...claim(current), branch: "oriel/forged" })).type, "rejected");
    assert.equal((await connection.rpc({ ...claim(current), version: "0".repeat(64) })).type, "rejected");
    assert.equal((await connection.rpc({ ...claim(current), kind: "implement" })).type, "rejected");
    const granted = await connection.rpc(claim(current));
    assert.equal(granted.type, "granted");
    assert.equal((await connection.rpc({ type: "check", lease_id: randomUUID() })).type, "rejected");
    const checked = await connection.rpc({ type: "check", lease_id: granted.lease_id });
    assert.equal(checked.type, "checked");
    assert.equal(checked.lease_id, granted.lease_id);
    assert.equal((await connection.rpc({ type: "heartbeat" })).type, "heartbeat");
    assert.equal((await gitToken(daemon, granted.lease_id)).status, 200);
    assert.equal((await gitToken(daemon, randomUUID())).status, 409);
    assert.equal((await owner.api(`/api/workflows/${device}/git-token`, { lease_id: granted.lease_id })).status, 401);
    assert.equal((await daemon.api(`/api/workflows/${device}/issues`, {
      title: "Host cannot create WHAT", body: "", request_id: randomUUID(),
    }, hostHeaders)).status, 403);
    const binary = connection.receive();
    connection.ws.send(new Uint8Array([0, 255, 27, 13, 128]));
    assert.deepEqual(await binary, { type: "rejected", request_id: null, error: "Workflow request rejected" });
    const malformed = connection.receive();
    connection.ws.send("not JSON: private-provider-token");
    assert.deepEqual(await malformed, { type: "rejected", request_id: null, error: "Workflow request rejected" });
    assert.equal((await connection.rpc({ type: "release", lease_id: granted.lease_id })).type, "released");
    fixture.failures.set("repository", 503);
    const failed = await connection.rpc(claim(current));
    assert.equal(failed.type, "rejected");
    assert.equal(failed.error, "Workflow request rejected");
    fixture.failures.delete("repository");
    assert.equal((await connection.rpc(claim(current))).type, "granted");
  } finally { await worker.dispose(); }
});

test("Two devices and foreign accounts cannot code or publish the same WHAT and canonical branch", { timeout: 60_000 }, async () => {
  const fixture = workflowFixture();
  fixture.addHow("Todo");
  const { worker, owner, daemon, user } = await setup(fixture);
  try {
    await addDevice(owner, daemon, user, secondDevice, secondToken);
    const first = await socket(worker);
    const second = await socket(worker, secondDevice, secondToken);
    const current = await row(daemon);
    assert.equal(current.phase, "approved");
    const granted = await first.rpc(claim(current, "implement"));
    assert.equal(granted.type, "granted");
    assert.equal((await gitToken(daemon, granted.lease_id)).status, 409);
    const begun = await daemon.api(`/api/workflows/${device}/actions`, { lease_id: granted.lease_id, action: "begin" }, hostHeaders);
    assert.equal(begun.status, 200, JSON.stringify(begun.data));
    assert.equal((await gitToken(daemon, granted.lease_id)).status, 200);
    assert.equal((await second.rpc(claim(current, "implement"))).type, "rejected");
    assert.equal((await gitToken(daemon, granted.lease_id, secondDevice, secondHeaders)).status, 409);
    assert.equal((await daemon.api(`/api/workflows/${secondDevice}/actions`, {
      lease_id: granted.lease_id, action: "publish", head_oid: fixture.target_oid, verified: true, summary: "Forged owner",
    }, secondHeaders)).status, 409);
    const foreignOwner = client(worker);
    const foreignUser = await foreignOwner.enroll(authenticator());
    const foreignDevice = "f".repeat(32);
    const foreignToken = "1".repeat(64);
    await addDevice(foreignOwner, daemon, foreignUser, foreignDevice, foreignToken);
    for (const provider of ["github", "linear"]) await connect(foreignOwner, fixture, provider);
    const foreign = await socket(worker, foreignDevice, foreignToken);
    assert.equal((await foreign.rpc(claim(current, "implement"))).type, "rejected");
    assert.equal((await gitToken(daemon, granted.lease_id, foreignDevice, { Authorization: `Bearer ${foreignToken}` })).status, 409);
    assert.equal((await first.rpc({ type: "release", lease_id: granted.lease_id })).type, "released");
    assert.equal((await gitToken(daemon, granted.lease_id)).status, 409);
    const next = await second.rpc(claim(current, "implement"));
    assert.equal(next.type, "granted");
    const began = await daemon.api(`/api/workflows/${secondDevice}/actions`, { lease_id: next.lease_id, action: "begin" }, secondHeaders);
    assert.equal(began.status, 200, JSON.stringify(began.data));
    assert.equal(began.data.branch, current.branch);
    assert.equal(fixture.refs.get(current.branch), fixture.target_oid);
    const replaced = second.ended;
    const resumed = await socket(worker, secondDevice, secondToken);
    assert.equal((await bounded(replaced)).code, 1008);
    assert.equal((await gitToken(daemon, next.lease_id, secondDevice, secondHeaders)).status, 409);
    const running = await row(daemon, secondDevice, secondHeaders);
    assert.equal(running.phase, "running");
    const readmitted = await resumed.rpc(claim(running, "implement"));
    assert.equal(readmitted.type, "granted");
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.equal((await resumed.rpc({ type: "check", lease_id: readmitted.lease_id })).type, "checked");
    assert.equal((await gitToken(daemon, readmitted.lease_id, secondDevice, secondHeaders)).status, 200);
    resumed.close();
    await bounded(resumed.ended);
    assert.equal((await gitToken(daemon, readmitted.lease_id, secondDevice, secondHeaders)).status, 409);
    const afterDisconnect = await foreign.rpc(claim(running, "implement"));
    assert.equal(afterDisconnect.type, "granted");
  } finally { await worker.dispose(); }
});

test("Async claims atomically contend and repository changes during admission fail closed", { timeout: 60_000 }, async () => {
  const fixture = workflowFixture();
  const { worker, owner, daemon, user } = await setup(fixture);
  const unblockers = [];
  try {
    await addDevice(owner, daemon, user, secondDevice, secondToken);
    const first = await socket(worker);
    const second = await socket(worker, secondDevice, secondToken);
    const current = await row(daemon);
    let arrivals = 0;
    let arrived;
    let release;
    const ready = new Promise(resolve => { arrived = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    unblockers.push(release);
    fixture.holdReads = async ({ provider, operation }) => {
      if (provider !== "github" || operation !== "repository" || arrivals >= 2) return;
      if (++arrivals === 2) arrived();
      await blocked;
    };
    const claims = [first.rpc(claim(current)), second.rpc(claim(current))];
    await bounded(ready);
    fixture.holdReads = null;
    release();
    const results = await Promise.all(claims);
    assert.deepEqual(results.map(result => result.type).sort(), ["granted", "rejected"]);
    const winner = results[0].type === "granted" ? first : second;
    const won = results.find(result => result.type === "granted");
    assert.equal((await winner.rpc({ type: "release", lease_id: won.lease_id })).type, "released");
    let raced;
    let unblock;
    const observed = new Promise(resolve => { raced = resolve; });
    const pause = new Promise(resolve => { unblock = resolve; });
    unblockers.push(unblock);
    fixture.holdReads = async ({ provider, operation }) => {
      if (provider === "github" && operation === "repository") { raced(); await pause; }
    };
    const racing = first.rpc(claim(current));
    await bounded(observed);
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    await storage.exec("UPDATE devices SET repository_generation = ? WHERE device_id = ?", randomUUID(), device);
    fixture.holdReads = null;
    unblock();
    const rejected = await racing;
    assert.ok(["rejected", "closed"].includes(rejected.type));
    assert.equal((await gitToken(daemon, randomUUID())).status, 409);
    const replacement = await socket(worker);
    assert.equal((await replacement.rpc(claim(await row(daemon)))).type, "granted");
  } finally {
    fixture.holdReads = null;
    for (const unblock of unblockers) unblock();
    await worker.dispose();
  }
});

test("Live grants fail closed for changed owners, host credentials, repositories and provider generations", { timeout: 60_000 }, async () => {
  const fixture = workflowFixture();
  const { worker, owner, daemon } = await setup(fixture);
  try {
    const stranger = client(worker);
    const foreign = await stranger.enroll(authenticator());
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    const original = (await storage.exec("SELECT * FROM devices WHERE device_id = ?", device))[0];
    const providers = await storage.exec("SELECT * FROM account_integrations WHERE user_id = ?", original.user_id);
    const changes = [
      ["UPDATE devices SET user_id = ? WHERE device_id = ?", foreign.id, device],
      ["UPDATE devices SET host_hash = ? WHERE device_id = ?", "0".repeat(64), device],
      ["UPDATE devices SET repository_generation = ? WHERE device_id = ?", randomUUID(), device],
      ["UPDATE devices SET repository = ? WHERE device_id = ?", JSON.stringify({ owner: "other", name: "repository" }), device],
      ["UPDATE account_integrations SET generation = ? WHERE user_id = ? AND provider = 'github'", randomUUID(), original.user_id],
      ["UPDATE account_integrations SET generation = ? WHERE user_id = ? AND provider = 'linear'", randomUUID(), original.user_id],
      ["UPDATE account_integrations SET active = NULL WHERE user_id = ? AND provider = 'github'", original.user_id],
      ["UPDATE account_integrations SET target = NULL WHERE user_id = ? AND provider = 'linear'", original.user_id],
    ];
    for (const change of changes) {
      const connection = await socket(worker);
      const granted = await connection.rpc(claim(await row(daemon)));
      assert.equal(granted.type, "granted");
      assert.equal((await daemon.api(`/api/integrations/${device}/repository`, {
        repository: { owner: " OCTOCAT ", name: "CONNECTED" },
      }, hostHeaders)).status, 200);
      assert.equal((await gitToken(daemon, granted.lease_id)).status, 200, "Identical normalized repository reports retain ownership");
      await storage.exec(...change);
      const denied = await gitToken(daemon, granted.lease_id);
      assert.ok([401, 403, 409].includes(denied.status), JSON.stringify(denied));
      // A protocol check exercises binding revocation even if HTTP host authentication rejects first.
      if (connection.ws.readyState === 1) await connection.rpc({ type: "check", lease_id: granted.lease_id });
      assert.equal((await bounded(connection.ended)).code, 1008);
      await storage.exec("UPDATE devices SET user_id = ?, host_hash = ?, repository = ?, repository_generation = ? WHERE device_id = ?",
        original.user_id, original.host_hash, original.repository, original.repository_generation, device);
      for (const provider of providers) await storage.exec("UPDATE account_integrations SET generation = ?, active = ?, target = ? WHERE user_id = ? AND provider = ?",
        provider.generation, provider.active, provider.target, provider.user_id, provider.provider);
    }
  } finally { await worker.dispose(); }
});

test("Heartbeat keeps a connection alive while a silent owner expires and alarm releases its grant", { timeout: 75_000 }, async () => {
  const fixture = workflowFixture();
  const { worker, owner, daemon, user } = await setup(fixture);
  let heartbeat;
  try {
    await addDevice(owner, daemon, user, secondDevice, secondToken);
    const silent = await socket(worker);
    const alive = await socket(worker, secondDevice, secondToken);
    const current = await row(daemon);
    const granted = await silent.rpc(claim(current));
    assert.equal(granted.type, "granted");
    const observer = await watch(worker, owner);
    assert.equal(progressDevice(await observer.snapshot()).task.issue_number, 42);
    let failure;
    heartbeat = setInterval(() => {
      alive.rpc({ type: "heartbeat" }).then(response => {
        if (response.type !== "heartbeat") failure = new Error(JSON.stringify(response));
      }).catch(error => { failure = error; });
    }, 10_000);
    assert.equal((await bounded(silent.ended, 55_000)).code, 1008);
    assert.equal(failure, undefined);
    assert.equal((await gitToken(daemon, granted.lease_id)).status, 409);
    const expired = progressDevice(await observer.snapshot(devices =>
      devices.find(current => current.device_id === device)?.state === "offline", 55_000));
    assert.deepEqual(expired, { device_id: device, state: "offline", stage: null, task: null, updated_at: null });
    const next = await alive.rpc(claim(current));
    assert.equal(next.type, "granted");
    assert.equal((await alive.rpc({ type: "check", lease_id: next.lease_id })).type, "checked");
    assert.equal((await gitToken(daemon, next.lease_id, secondDevice, secondHeaders)).status, 200);
  } finally { clearInterval(heartbeat); await worker.dispose(); }
});
