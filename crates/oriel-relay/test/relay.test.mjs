import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { origin, device, hostToken, hostHeaders, authenticator, runtime, client, pair, githubFixture, authorize, connect, unseal } from "./helpers.mjs";
import { workflowFixture } from "./workflow-fixture.mjs";

async function credentialLease(worker, fixture, owner, daemon) {
  for (const provider of ["github", "linear"]) await connect(owner, fixture, provider);
  assert.equal((await daemon.api(`/api/integrations/${device}/repository`, {
    repository: { owner: fixture.repository.owner, name: fixture.repository.name },
  }, hostHeaders)).status, 200);
  const snapshot = await daemon.api(`/api/workflows/${device}`, undefined, hostHeaders);
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.data));
  const upgrade = await worker.dispatchFetch(`${origin}/api/workflows/${device}/connect`, {
    headers: { Upgrade: "websocket", ...hostHeaders },
  });
  assert.equal(upgrade.status, 101);
  const socket = upgrade.webSocket;
  socket.accept();
  const response = new Promise(resolve => socket.addEventListener("message", event => resolve(JSON.parse(event.data)), { once: true }));
  const row = snapshot.data.workflows[0];
  socket.send(JSON.stringify({ type: "claim", request_id: crypto.randomUUID(), kind: "plan",
    issue_number: row.issue.number, version: row.version, branch: row.branch }));
  const grant = await response;
  assert.equal(grant.type, "granted", JSON.stringify(grant));
  return { socket, lease_id: grant.lease_id };
}

// Run npm run build first. Every test uses isolated real Worker/SQLite storage.
test("Passkeys, local pairing confirmation and ownership protect opaque terminal relay", { timeout: 30000 }, async () => {
  const worker = await runtime();
  const owner = client(worker);
  const stranger = client(worker);
  const anonymous = client(worker);
  const key = authenticator();
  try {
    assert.equal((await anonymous.upgrade("host")).status, 401);
    assert.equal((await anonymous.upgrade("client")).status, 401);
    assert.equal((await anonymous.api("/api/auth/register/options", {}, { Origin: "https://evil.example" })).status, 403);
    const user = await owner.enroll(key);
    await stranger.enroll(authenticator());
    const backup = authenticator();
    assert.deepEqual(await owner.enroll(backup), user);
    assert.equal((await owner.api("/api/auth/logout", {})).status, 200);
    assert.equal((await owner.api("/api/devices")).status, 401);

    const loginOptions = await owner.api("/api/auth/login/options", {});
    const credential = backup.login(loginOptions.data.options);
    const challengeCookie = [...owner.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const login = await owner.api("/api/auth/login/verify", { credential });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    assert.deepEqual(login.data.user, user);
    assert.equal((await owner.api("/api/auth/login/verify", { credential }, { Cookie: challengeCookie })).status, 400);
    const invalidOptions = await stranger.api("/api/auth/login/options", {});
    const invalid = key.login(invalidOptions.data.options);
    invalid.response.signature = randomBytes(72).toString("base64url");
    assert.equal((await stranger.api("/api/auth/login/verify", { credential: invalid })).status, 400);

    const daemon = client(worker);
    const hostHeaders = { Authorization: `Bearer ${hostToken}` };
    const started = await daemon.api("/api/pair/start", { device_id: device, name: "test-machine" }, hostHeaders);
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.status, "pending");
    const token = new URL(started.data.url).hash.slice("#pair=".length);
    assert.equal((await anonymous.api("/api/pair/claim", { token })).status, 401);
    assert.equal((await owner.api("/api/pair/inspect", { token })).data.device_id, device);
    assert.equal((await owner.api("/api/pair/claim", { token })).status, 200);
    assert.equal((await stranger.api("/api/pair/claim", { token })).status, 409);
    assert.equal((await owner.upgrade("client")).status, 403);
    assert.equal((await daemon.api(`/api/pair/${device}/confirm`, { user_id: "0".repeat(32) }, hostHeaders)).status, 409);
    const pending = await daemon.api(`/api/pair/${device}/status`, undefined, hostHeaders);
    assert.equal(pending.data.status, "confirmation");
    assert.deepEqual(pending.data.user, user);
    assert.equal((await daemon.api(`/api/pair/${device}/confirm`, { user_id: user.id }, hostHeaders)).status, 200);
    assert.equal((await daemon.api("/api/pair/start", { device_id: device, name: "test-machine" }, hostHeaders)).data.status, "paired");
    assert.equal((await daemon.api("/api/pair/start", { device_id: device, name: "stolen" }, { Authorization: `Bearer ${"c".repeat(64)}` })).status, 403);
    assert.equal((await stranger.upgrade("client")).status, 403);
    assert.equal((await owner.upgrade("client", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await stranger.api("/api/devices")).data.devices.length, 0);
    assert.equal((await owner.api("/api/devices")).data.devices[0].device_id, device);

    const host = await daemon.upgrade("host", { ...hostHeaders, Cookie: "" });
    assert.equal(host.status, 101);
    host.webSocket.addEventListener("message", event => {
      if (typeof event.data === "string" && event.data.startsWith("\u001eoriel-heartbeat:")) {
        host.webSocket.send(event.data.replace("oriel-heartbeat:", "oriel-heartbeat-ack:"));
      }
    });
    host.webSocket.accept();
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await owner.api("/api/devices")).data.devices[0].terminal_status === "online") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const terminal = await owner.upgrade("client");
    assert.equal(terminal.status, 101);
    assert.equal(terminal.headers.get("Sec-WebSocket-Protocol"), "oriel-client");
    terminal.webSocket.accept();
    assert.equal((await anonymous.upgrade("host")).status, 401);
    assert.equal((await anonymous.upgrade("client")).status, 401);
    const atHost = new Promise((resolve, reject) => {
      host.webSocket.addEventListener("message", event => resolve(event.data), { once: true });
      host.webSocket.addEventListener("close", () => reject(new Error("unauthorized connection evicted host")), { once: true });
    });
    const input = new Uint8Array([0, 255, 27, 13, 128]);
    terminal.webSocket.send(input);
    assert.deepEqual(new Uint8Array(await atHost), input);
    const atClient = new Promise((resolve, reject) => {
      terminal.webSocket.addEventListener("message", event => resolve(event.data), { once: true });
      terminal.webSocket.addEventListener("close", () => reject(new Error("unauthorized connection evicted client")), { once: true });
    });
    host.webSocket.send("opaque terminal-independent frame");
    assert.equal(await atClient, "opaque terminal-independent frame");
  } finally {
    await worker.dispose();
  }
});


test("Account connections serve both owned devices, keep credentials encrypted across eviction and logout", { timeout: 60000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const { owner, daemon, user } = await pair(worker);
    const other = "d".repeat(32);
    const start = await daemon.api("/api/pair/start", { device_id: other, name: "second" }, hostHeaders);
    const token = new URL(start.data.url).hash.slice("#pair=".length);
    await owner.api("/api/pair/claim", { token });
    assert.equal((await daemon.api(`/api/pair/${other}/confirm`, { user_id: user.id }, hostHeaders)).status, 200);
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    for (const provider of ["github", "linear"]) await connect(owner, fixture, provider);
    const expected = { github: fixture.repository, linear: fixture.team };
    assert.deepEqual((await daemon.api(`/api/integrations/${device}`, undefined, hostHeaders)).data, expected);
    assert.deepEqual((await daemon.api(`/api/integrations/${other}`, undefined, hostHeaders)).data, expected);
    assert.deepEqual((await stranger.api("/api/integrations")).data, {
      github: null, linear: null, choices: { github: [], linear: [] },
      authorization: { github: null, linear: null },
    });
    assert.equal((await stranger.api("/api/integrations/github/select", { installation_id: 101, repository_id: 501 })).status, 409);
    assert.equal((await stranger.api(`/api/integrations/${device}`, undefined, { Authorization: `Bearer ${"e".repeat(64)}` })).status, 403);
    assert.equal((await client(worker).api(`/api/integrations/${device}`)).status, 401);
    assert.equal((await owner.api("/api/integrations/github/start", {}, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await daemon.api(`/api/integrations/${device}/github/start`, {}, hostHeaders)).status, 404);
    const browser = (await owner.api("/api/integrations")).data;
    assert.deepEqual(browser, { ...expected, choices: { github: [], linear: [] }, authorization: { github: null, linear: null } });
    assert.equal((await daemon.api(`/api/integrations/${other}/github/token`, {}, hostHeaders)).status, 404);
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    const rows = await storage.exec("SELECT * FROM account_integrations");
    for (const row of rows) {
      assert.equal(row.user_id, user.id);
      assert.equal(JSON.stringify(row).includes("private-"), false);
      assert.equal((await unseal(row.active, user.id, row.provider)).access_token, row.provider === "github" ? fixture.githubToken : fixture.linearToken);
      await assert.rejects(unseal(row.active, "foreign-account", row.provider));
      await assert.rejects(unseal(row.active, user.id, row.provider === "github" ? "linear" : "github"));
    }
    const issues = (await owner.api("/api/integrations/issues")).data;
    assert.deepEqual(issues.linear, { team: fixture.team, issues: [{ identifier: "ENG-42", title: "Linear issue" }] });
    assert.deepEqual(issues.github.issues, Array.from({ length: 20 }, (_, index) => ({ number: index + 2, title: `Issue ${index + 2}` })));
    assert.deepEqual((await daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders)).data, issues);
    assert.equal(JSON.stringify([browser, issues]).includes("private-"), false);
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.deepEqual((await owner.api("/api/integrations")).data, browser);
    assert.deepEqual((await daemon.api(`/api/integrations/${other}/issues`, undefined, hostHeaders)).data, issues);
    await owner.api("/api/auth/logout", {});
    assert.deepEqual((await daemon.api(`/api/integrations/${device}`, undefined, hostHeaders)).data, expected);
  } finally { await worker.dispose(); }
});

test("OAuth choices survive eviction, reject fabricated targets and recheck GitHub installation management", { timeout: 60000 }, async () => {
  const fixture = githubFixture({ paginated: true });
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const { owner, daemon } = await pair(worker);
    const state = await authorize(owner, fixture, "github");
    await owner.callback("github", state);
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    const choices = (await owner.api("/api/integrations")).data.choices.github;
    assert.ok(choices.some(repository => JSON.stringify(repository) === JSON.stringify(fixture.repository)));
    assert.ok(choices.every(repository => repository.installation_id === 101));
    assert.equal((await owner.callback("github", state)).status, 409);
    const path = "/api/integrations/github/select";
    assert.equal((await owner.api(path, { installation_id: 1, repository_id: 501 })).status, 403);
    assert.equal((await owner.api(path, { installation_id: 101, repository_id: 9999 })).status, 403);
    fixture.management = false;
    assert.equal((await owner.api(path, { installation_id: 101, repository_id: 501 })).status, 403);
    fixture.organization = true;
    assert.equal((await owner.api(path, { installation_id: 101, repository_id: 501 })).status, 403);
    fixture.management = true;
    assert.equal((await owner.api(path, { installation_id: 101, repository_id: 501 })).status, 200);
    await connect(owner, fixture, "linear");
    const pending = await authorize(owner, fixture, "linear");
    await owner.callback("linear", pending);
    assert.deepEqual((await daemon.api(`/api/integrations/${device}`, undefined, hostHeaders)).data.linear, fixture.team);
    assert.equal((await owner.api("/api/integrations/linear/select", { team_id: "foreign", team_name: "Forged", workspace_id: "foreign" })).status, 403);
    assert.equal((await owner.api("/api/integrations/linear/select", { team_id: "team", team_name: "Forged", workspace_id: "foreign" })).status, 200);
    assert.deepEqual((await owner.api("/api/integrations")).data.linear, fixture.team);
  } finally { await worker.dispose(); }
});

test("OAuth binds the exact live session and rejects expired, superseded and logout-racing exchanges", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  let release;
  try {
    const { owner, key } = await pair(worker);
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    const state = await authorize(owner, fixture, "github");
    assert.equal((await stranger.callback("github", state)).status, 403);
    const secondSession = client(worker);
    const login = await secondSession.api("/api/auth/login/options", {});
    assert.equal((await secondSession.api("/api/auth/login/verify", { credential: key.login(login.data.options) })).status, 200);
    assert.equal((await secondSession.callback("github", state)).status, 403);
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    await storage.exec("UPDATE account_oauth SET expires_at = ? WHERE state = ?", Math.floor(Date.now() / 1000) - 1, state);
    assert.equal((await owner.callback("github", state)).status, 410);
    const first = await authorize(owner, fixture, "github");
    const replacement = await authorize(owner, fixture, "github");
    assert.equal((await owner.callback("github", first)).status, 409);
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fixture.exchange = async () => { entered(); await gate; };
    const pending = owner.callback("github", replacement);
    await fetching;
    const newest = await authorize(owner, fixture, "github");
    release();
    assert.equal((await pending).headers.get("Location"), `${origin}/#connection-error=authorization-failed`);
    let enteredAgain;
    const fetchingAgain = new Promise(resolve => { enteredAgain = resolve; });
    const gateAgain = new Promise(resolve => { release = resolve; });
    fixture.exchange = async () => { enteredAgain(); await gateAgain; };
    const revoked = owner.callback("github", newest);
    await fetchingAgain;
    const oldCookies = [...owner.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    await owner.api("/api/auth/logout", {});
    release();
    assert.equal((await revoked).headers.get("Location"), `${origin}/#connection-error=authorization-failed`);
    assert.equal((await worker.dispatchFetch(`${origin}/api/integrations/callback/github?state=${newest}&code=secret`, { headers: { Cookie: oldCookies } })).status, 401);
    const afterLogout = (await secondSession.api("/api/integrations")).data;
    assert.equal(afterLogout.github, null);
    assert.deepEqual(afterLogout.choices.github, []);
    assert.equal(afterLogout.authorization.github.status, "failed");
  } finally { release?.(); await worker.dispose(); }
});

test("Relay exchanges PKCE and rotates both providers; disconnect prevents refresh resurrection", { timeout: 60000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  let release;
  try {
    const { owner, daemon, user } = await pair(worker);
    const state = await authorize(owner, fixture, "linear");
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    const flow = (await storage.exec("SELECT * FROM account_oauth WHERE state = ?", state))[0];
    const verifier = await unseal(flow.verifier, user.id, "linear", "pkce");
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), fixture.pkce);
    assert.equal(flow.verifier.includes(verifier), false);
    fixture.expiresIn = 1;
    await owner.callback("linear", state);
    assert.equal((await owner.api("/api/integrations/linear/select", { team_id: "team" })).status, 200);
    assert.equal(fixture.refreshCount, 1);
    let row = (await storage.exec("SELECT * FROM account_integrations WHERE provider = 'linear'"))[0];
    let value = await unseal(row.active, user.id, "linear");
    assert.equal(value.access_token, "rotated-linear-access");
    assert.equal(value.refresh_token, "rotated-linear-refresh");
    assert.ok(value.expires_at > Math.floor(Date.now() / 1000) + 3600);
    await connect(owner, fixture, "github");
    assert.equal(fixture.refreshCount, 2);
    row = (await storage.exec("SELECT * FROM account_integrations WHERE provider = 'github'"))[0];
    assert.equal((await unseal(row.active, user.id, "github")).refresh_token, "rotated-github-refresh");
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.equal((await daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders)).status, 200);
    assert.equal(fixture.refreshCount, 2);
    fixture.expiresIn = 130;
    fixture.linearToken = "private-linear-access";
    await connect(owner, fixture, "linear");
    row = (await storage.exec("SELECT * FROM account_integrations WHERE provider = 'linear'"))[0];
    value = await unseal(row.active, user.id, "linear");
    value.expires_at = Math.floor(Date.now() / 1000) - 1;
    const key = await crypto.subtle.importKey("raw", Buffer.from("CD".repeat(32), "hex"), "AES-GCM", false, ["encrypt"]);
    const iv = randomBytes(12);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: Buffer.from(JSON.stringify([user.id, "linear", "credentials"])) }, key, Buffer.from(JSON.stringify(value)));
    await storage.exec("UPDATE account_integrations SET active = ? WHERE provider = 'linear'", JSON.stringify({ iv: iv.toString("base64"), data: Buffer.from(encrypted).toString("base64") }));
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fixture.refresh = async () => { entered(); await gate; };
    const pending = daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders);
    await fetching;
    assert.deepEqual((await owner.api("/api/integrations/linear/disconnect", {})).data, { ok: true, revoked: true });
    release();
    assert.equal((await pending).status, 409);
    assert.equal((await owner.api("/api/integrations")).data.linear, null);
    assert.deepEqual(await storage.exec("SELECT * FROM account_integrations WHERE provider = 'linear'"), []);
    fixture.revokeFailed = true;
    assert.deepEqual((await owner.api("/api/integrations/github/disconnect", {})).data, { ok: true, revoked: false });
    assert.deepEqual((await daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders)).data, { github: null, linear: null });
  } finally { release?.(); await worker.dispose(); }
});

test("Interrupted exchanges require explicit retry, disconnect invalidates callbacks, and errors are sanitized", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  let release;
  try {
    const { owner } = await pair(worker);
    const state = await authorize(owner, fixture, "github");
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    await storage.exec("UPDATE account_oauth SET phase = 'processing' WHERE state = ?", state);
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    const interrupted = await owner.callback("github", state);
    assert.equal(interrupted.status, 409);
    assert.match((await interrupted.json()).error, /retry authorization in Web/);
    const retry = await authorize(owner, fixture, "github");
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fixture.exchange = async () => { entered(); await gate; };
    const pending = owner.callback("github", retry);
    await fetching;
    assert.equal((await owner.api("/api/integrations/github/disconnect", {})).status, 200);
    release();
    assert.equal((await pending).headers.get("Location"), `${origin}/#connection-error=authorization-failed`);
    assert.equal((await owner.callback("github", retry)).status, 409);
    fixture.exchange = undefined;
    await connect(owner, fixture, "linear");
    fixture.apiFailed = true;
    const failed = await owner.api("/api/integrations/issues");
    assert.equal(failed.status, 502);
    assert.equal(JSON.stringify(failed.data).includes("secret-provider"), false);
  } finally { release?.(); await worker.dispose(); }
});

test("Missing provider encryption configuration leaves pairing and empty connections usable", { timeout: 30000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon } = await pair(worker);
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    await storage.exec("CREATE TABLE github_bindings (device_id TEXT PRIMARY KEY, installation_id INTEGER, repository_id INTEGER, owner TEXT, name TEXT)");
    await storage.exec("INSERT INTO github_bindings VALUES (?, 101, 501, 'octocat', 'obsolete')", device);
    await storage.exec("CREATE TABLE linear_bindings (device_id TEXT PRIMARY KEY, team_id TEXT, team_name TEXT, workspace_id TEXT)");
    await storage.exec("INSERT INTO linear_bindings VALUES (?, 'old-team', 'Old local selection', 'old-workspace')", device);
    await storage.exec("CREATE TABLE integration_flows (state TEXT PRIMARY KEY)");
    await storage.exec("INSERT INTO integration_flows VALUES (?)", "f".repeat(64));
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    for (const provider of ["github", "linear"]) {
      const result = await owner.api(`/api/integrations/${provider}/start`, {});
      assert.equal(result.status, 503);
      assert.match(result.data.error, /INTEGRATION_ENCRYPTION_KEY/);
    }
    assert.deepEqual((await owner.api("/api/integrations")).data, {
      github: null, linear: null, choices: { github: [], linear: [] },
      authorization: { github: null, linear: null },
    });
    assert.deepEqual((await daemon.api(`/api/integrations/${device}`, undefined, hostHeaders)).data, { github: null, linear: null });
    assert.deepEqual((await daemon.api(`/api/pair/${device}/status`, undefined, hostHeaders)).data, { status: "paired" });
  } finally { await worker.dispose(); }
});

test("Disconnecting a provider invalidates an issue snapshot waiting on the other provider", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  let release;
  try {
    const { owner, daemon } = await pair(worker);
    await connect(owner, fixture, "github");
    await connect(owner, fixture, "linear");
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fixture.issues = async () => { entered(); await gate; };
    const pending = daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders);
    await fetching;
    assert.deepEqual((await owner.api("/api/integrations/github/disconnect", {})).data, { ok: true, revoked: true });
    release();
    assert.equal((await pending).status, 409);
  } finally { release?.(); await worker.dispose(); }
});

test("Revoked GitHub user authorization blocks new installation tokens", { timeout: 30000 }, async () => {
  const fixture = workflowFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    let lease;
    const { owner, daemon } = await pair(worker);
    lease = await credentialLease(worker, fixture, owner, daemon);
    fixture.githubAuthorizationRevoked = true;
    const denied = await daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease.lease_id }, hostHeaders);
    assert.equal(denied.status, 502);
    assert.equal(denied.data.token, undefined);
    lease.socket.close();
  } finally { await worker.dispose(); }
});

test("Authorization outcomes distinguish rejected credentials, failed target access and empty repository choices", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const owner = client(worker);
    await owner.enroll(authenticator());
    const snapshot = async () => (await owner.api("/api/integrations")).data;
    fixture.oauthError = "incorrect_client_credentials";
    await owner.callback("github", await authorize(owner, fixture, "github"));
    assert.deepEqual((await snapshot()).authorization.github, { status: "failed", step: "exchange", error: "incorrect_client_credentials" });
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.equal((await snapshot()).authorization.github.error, "incorrect_client_credentials");
    fixture.oauthError = "secret-untrusted-provider-error";
    await owner.callback("github", await authorize(owner, fixture, "github"));
    assert.deepEqual((await snapshot()).authorization.github, { status: "failed", step: "exchange", error: "invalid_token_response" });
    assert.doesNotMatch(JSON.stringify(await snapshot()), /private-provider|must-not-leak|secret-untrusted/);
    fixture.oauthError = undefined;
    fixture.githubAuthorizationRevoked = true;
    await owner.callback("github", await authorize(owner, fixture, "github"));
    assert.deepEqual((await snapshot()).authorization.github, { status: "failed", step: "targets", error: "http_401" });
    fixture.githubAuthorizationRevoked = false;
    fixture.noInstallations = true;
    await owner.callback("github", await authorize(owner, fixture, "github"));
    const empty = await snapshot();
    assert.deepEqual(empty.authorization.github, { status: "ready" });
    assert.deepEqual(empty.choices.github, []);
    assert.equal(empty.github, null);
    fixture.noInstallations = false;
    await connect(owner, fixture, "github");
    const connected = await snapshot();
    assert.equal(connected.authorization.github, null);
    assert.equal(connected.github.repository_id, fixture.repository.repository_id);
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    assert.equal((await stranger.api("/api/integrations")).data.authorization.github, null);
  } finally { await worker.dispose(); }
});

test("Installation token rejection preserves the connection and never releases provider credentials", { timeout: 30000 }, async () => {
  const fixture = workflowFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const { owner, daemon } = await pair(worker);
    const lease = await credentialLease(worker, fixture, owner, daemon);
    fixture.tokenStatus = 422;
    const denied = await daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease.lease_id }, hostHeaders);
    assert.equal(denied.status, 502);
    assert.equal(denied.data.token, undefined);
    assert.doesNotMatch(JSON.stringify(denied.data), /private-provider-diagnostic|must-not-leak-token/);
    assert.equal((await owner.api("/api/integrations")).data.github.repository_id, fixture.repository.repository_id);
    fixture.tokenStatus = undefined;
    const restored = await daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease.lease_id }, hostHeaders);
    assert.equal(restored.status, 200);
    assert.equal(restored.data.repository.repository_id, fixture.repository.repository_id);
    assert.equal(restored.data.token, "limited-installation-token");
    lease.socket.close();
  } finally { await worker.dispose(); }
});

test("Only the paired host reports normalized repository metadata; existing devices migrate without losing ownership", { timeout: 30000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon } = await pair(worker);
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    const route = `/api/integrations/${device}/repository`;
    const repository = { owner: "octocat", name: "working" };
    const devices = () => owner.api("/api/devices");
    assert.deepEqual((await devices()).data.devices, [{ device_id: device, name: "integration-host", repository: null, terminal_status: "offline" }]);
    assert.equal((await owner.api(route, { repository })).status, 401);
    assert.equal((await stranger.api(route, { repository })).status, 401);
    assert.equal((await stranger.api(route, { repository }, { Authorization: `Bearer ${"e".repeat(64)}` })).status, 403);
    assert.equal((await daemon.api(`/api/integrations/${"f".repeat(32)}/repository`, { repository }, hostHeaders)).status, 403);
    for (const value of [undefined, {}, { owner: "octocat/path", name: "working" }, { owner: "https://github.com/octocat", name: "working" },
      { owner: "octocat", name: "../working" }, { owner: "user:password@github.com", name: "working" }, { owner: "octocat", name: "." }]) {
      assert.equal((await daemon.api(route, { repository: value }, hostHeaders)).status, 400);
    }
    assert.deepEqual((await daemon.api(route, { repository: { owner: " OctoCat ", name: " WORKING ", remote: "private-remote" }, transcript: "private-transcript" }, hostHeaders)).data, { ok: true });
    assert.deepEqual((await devices()).data.devices[0].repository, repository);
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.doesNotMatch(JSON.stringify(await storage.exec("SELECT * FROM devices")), /private-remote|private-transcript/);
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.deepEqual((await devices()).data.devices[0].repository, repository);
    assert.deepEqual((await daemon.api(route, { repository: null }, hostHeaders)).data, { ok: true });
    assert.equal((await devices()).data.devices[0].repository, null);
    await storage.exec("ALTER TABLE devices RENAME TO current_devices");
    await storage.exec("CREATE TABLE devices (device_id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL, host_hash TEXT NOT NULL)");
    await storage.exec("INSERT INTO devices SELECT device_id, name, user_id, host_hash FROM current_devices");
    await storage.exec("DROP TABLE current_devices");
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.deepEqual((await devices()).data.devices, [{ device_id: device, name: "integration-host", repository: null, terminal_status: "offline" }]);
    assert.equal((await daemon.api(route, { repository }, hostHeaders)).status, 200);
    assert.deepEqual((await devices()).data.devices[0].repository, repository);
  } finally { await worker.dispose(); }
});

test("Repository-linked Linear discovery requires device ownership, respects missing context and never calls GitHub", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime({ ...fixture.env, GITHUB_CLIENT_ID: "", GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "" }, request => fixture.fetch(request));
  try {
    const { owner, daemon } = await pair(worker);
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    const route = `/api/integrations/${device}/linear/issues`;
    const report = repository => daemon.api(`/api/integrations/${device}/repository`, { repository }, hostHeaders);
    assert.deepEqual((await owner.api(route)).data, { repository: null, linear: null });
    assert.equal((await stranger.api(route)).status, 403);
    assert.equal((await client(worker).api(route)).status, 401);
    assert.equal((await owner.api(route, undefined, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await owner.api(route, undefined, { Authorization: "Bearer invalid" })).status, 401);
    assert.equal((await owner.api(route, undefined, { Authorization: `Bearer ${"e".repeat(64)}` })).status, 403);
    await connect(owner, fixture, "linear");
    assert.deepEqual((await owner.api(route)).data, { repository: null, linear: { team: fixture.team, issues: [] } });
    const repository = { owner: "octocat", name: "working" };
    await report(repository);
    assert.deepEqual((await owner.api(route)).data, { repository, linear: { team: fixture.team, issues: [] } });
    fixture.linkedIssues[0].attachments = [{ url: "https://github.com/octocat/working/issues/42" }];
    const { team: _team, attachments: _attachments, ...issue } = fixture.linkedIssues[0];
    const expected = { repository, linear: { team: fixture.team, issues: [{ ...issue, github_issues: [{ number: 42, url: "https://github.com/octocat/working/issues/42" }] }] } };
    assert.deepEqual((await owner.api(route)).data, expected);
    assert.deepEqual((await daemon.api(route, undefined, { ...hostHeaders, Origin: "" })).data, expected);
    const other = "d".repeat(32);
    const start = await daemon.api("/api/pair/start", { device_id: other, name: "other-repository" }, hostHeaders);
    await owner.api("/api/pair/claim", { token: new URL(start.data.url).hash.slice("#pair=".length) });
    const user = (await owner.api("/api/session")).data.user;
    await daemon.api(`/api/pair/${other}/confirm`, { user_id: user.id }, hostHeaders);
    await daemon.api(`/api/integrations/${other}/repository`, { repository: { owner: "octocat", name: "elsewhere" } }, hostHeaders);
    assert.deepEqual((await owner.api(`/api/integrations/${other}/linear/issues`)).data, {
      repository: { owner: "octocat", name: "elsewhere" }, linear: { team: fixture.team, issues: [] },
    });
    const foreignDevice = "c".repeat(32);
    const foreignHeaders = { Authorization: `Bearer ${"e".repeat(64)}` };
    const foreignStart = await daemon.api("/api/pair/start", { device_id: foreignDevice, name: "foreign-account" }, foreignHeaders);
    await stranger.api("/api/pair/claim", { token: new URL(foreignStart.data.url).hash.slice("#pair=".length) });
    const foreignUser = (await stranger.api("/api/session")).data.user;
    await daemon.api(`/api/pair/${foreignDevice}/confirm`, { user_id: foreignUser.id }, foreignHeaders);
    await daemon.api(`/api/integrations/${foreignDevice}/repository`, { repository }, foreignHeaders);
    assert.deepEqual((await stranger.api(`/api/integrations/${foreignDevice}/linear/issues`)).data, { repository, linear: null });
    assert.equal((await owner.api(`/api/integrations/${foreignDevice}/linear/issues`)).status, 403);
    assert.equal((await daemon.api(`/api/integrations/${foreignDevice}/linear/issues`, undefined, hostHeaders)).status, 403);
    await report(null);
    assert.deepEqual((await owner.api(route)).data, { repository: null, linear: { team: fixture.team, issues: [] } });
    await owner.api("/api/integrations/linear/disconnect", {});
    assert.deepEqual((await owner.api(route)).data, { repository: null, linear: null });
    assert.equal(fixture.githubRequests, 0);
  } finally { await worker.dispose(); }
});

test("Linked Linear discovery traverses all issues and attachments, deduplicates actual links and rejects URL impostors", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const template = fixture.linkedIssues[0];
  const url = number => `https://github.com/octocat/working/issues/${number}`;
  fixture.linkedIssues = Array.from({ length: 125 }, (_, index) => ({ ...template, id: `issue-${index}`, identifier: `ENG-${index}`,
    description: index === 124 ? null : `HOW ${index}`, attachments: [{ url: url(index + 1) }] }));
  const duplicate = { ...fixture.linkedIssues[124], attachments: [{ url: url(126) }] };
  const boundary = { ...template, id: "boundary", identifier: "ENG-boundary", attachments: [
    ...Array.from({ length: 100 }, () => ({ url: url(0) })),
    { url: "HTTPS://GITHUB.COM/OctoCat/Working/issues/00042/?via=linear#attached" },
    { url: `${url(42)}#duplicate` }, { url: url(Number.MAX_SAFE_INTEGER) },
    ...["9007199254740992", "-1", "1.2", "1/extra", "1//", "1/../2", "%31"].map(number => ({ url: url(number) })),
  ] };
  fixture.linkedIssues.push(duplicate, boundary);
  for (const attachments of [
    [{ url: "https://github.com/octocat/working/pull/1" }], [{ url: "https://github.com/octocat/elsewhere/issues/1" }],
    [{ url: "https://github.com.evil.example/octocat/working/issues/1" }], [{ url: "http://github.com/octocat/working/issues/1" }],
    [{ url: "https://user:password@github.com/octocat/working/issues/1" }], [{ url: url(0) }], [],
  ]) fixture.linkedIssues.push({ ...template, id: `impostor-${fixture.linkedIssues.length}`,
    title: `GitHub ${url(42)}`, description: `Implement ${url(42)}`, attachments });
  fixture.linkedIssues.push({ ...template, id: "wrong-team", team: { id: "foreign-team" }, attachments: [{ url: url(42) }] });
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const { owner, daemon } = await pair(worker);
    await connect(owner, fixture, "linear");
    await daemon.api(`/api/integrations/${device}/repository`, { repository: { owner: "octocat", name: "working" } }, hostHeaders);
    const result = await owner.api(`/api/integrations/${device}/linear/issues`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const actual = result.data.linear.issues;
    const expected = fixture.linkedIssues.slice(0, 125).map(({ team, attachments, ...issue }, index) => ({
      ...issue, github_issues: [{ number: index + 1, url: url(index + 1) }, ...(index === 124 ? [{ number: 126, url: url(126) }] : [])],
    }));
    const { team, attachments, ...metadata } = boundary;
    expected.push({ ...metadata, github_issues: [{ number: 42, url: url(42) }, { number: Number.MAX_SAFE_INTEGER, url: url(Number.MAX_SAFE_INTEGER) }] });
    assert.deepEqual(actual, expected);
    assert.equal(fixture.githubRequests, 0);
  } finally { await worker.dispose(); }
});

test("Repository-linked snapshots fail closed across browser logout, repository changes, device ownership and provider replacement", { timeout: 120000 }, async t => {
  for (const race of ["logout", "clear", "repository-roundtrip", "owner", "disconnect", "reconnect"]) await t.test(race, async () => {
    const fixture = githubFixture();
    fixture.linkedIssues[0].attachments.push({ url: "https://github.com/octocat/connected/issues/43" });
    fixture.attachmentPageSize = 1;
    const worker = await runtime(fixture.env, request => fixture.fetch(request));
    let release;
    try {
      const { owner, daemon } = await pair(worker);
      await connect(owner, fixture, "linear");
      const report = repository => daemon.api(`/api/integrations/${device}/repository`, { repository }, hostHeaders);
      const repository = { owner: "octocat", name: "connected" };
      await report(repository);
      let entered;
      const fetching = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      fixture.linkedFetch = async ({ variables }) => { if (variables.id) { entered(); await gate; } };
      const pending = race === "logout" ? owner.api(`/api/integrations/${device}/linear/issues`) :
        daemon.api(`/api/integrations/${device}/linear/issues`, undefined, hostHeaders);
      await fetching;
      if (race === "logout") await owner.api("/api/auth/logout", {});
      else if (race === "clear") await report(null);
      else if (race === "repository-roundtrip") {
        await report({ owner: "octocat", name: "different" });
        await report(repository);
      } else if (race === "owner") {
        const stranger = client(worker);
        const user = await stranger.enroll(authenticator());
        const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
        await storage.exec("UPDATE devices SET user_id = ? WHERE device_id = ?", user.id, device);
      } else {
        await owner.api("/api/integrations/linear/disconnect", {});
        if (race === "reconnect") await connect(owner, fixture, "linear");
      }
      release();
      const failed = await pending;
      assert.equal(failed.status, race === "logout" ? 401 : race === "owner" ? 403 : 409);
      assert.equal(failed.data.linear, undefined);
      assert.doesNotMatch(JSON.stringify(failed.data), /ENG-42|human approval|private-linear/);
    } finally { release?.(); await worker.dispose(); }
  });
});

test("Linked Linear provider failures are sanitized and pagination cannot cycle or silently truncate", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const { owner, daemon } = await pair(worker);
    await connect(owner, fixture, "linear");
    await daemon.api(`/api/integrations/${device}/repository`, { repository: { owner: "octocat", name: "connected" } }, hostHeaders);
    fixture.apiFailed = true;
    const route = `/api/integrations/${device}/linear/issues`;
    const failed = await owner.api(route);
    assert.equal(failed.status, 502);
    assert.doesNotMatch(JSON.stringify(failed.data), /secret-provider|private-linear/);
    fixture.apiFailed = false;
    const fetch = fixture.fetch.bind(fixture);
    const original = fixture.linkedIssues[0];
    fixture.linkedIssues.push({ ...original, id: "second" });
    fixture.issuePageSize = 1;
    fixture.fetch = async request => {
      const response = await fetch(request);
      if (new URL(request.url).pathname !== "/graphql") return response;
      const data = await response.json();
      if (data.data?.issues) data.data.issues.pageInfo = { hasNextPage: true, endCursor: "1" };
      return Response.json(data);
    };
    assert.equal((await owner.api(route)).status, 502);
    fixture.fetch = fetch;
    fixture.linkedIssues = [original];
    fixture.fetch = async request => {
      const response = await fetch(request);
      if (new URL(request.url).pathname !== "/graphql") return response;
      const data = await response.json();
      if (data.data?.issues) data.data.issues.nodes[0].attachments.pageInfo = { hasNextPage: true, endCursor: null };
      return Response.json(data);
    };
    assert.equal((await owner.api(route)).status, 502);
  } finally { await worker.dispose(); }
});

test("host disconnect stays listed and terminal reopens after reconnect without pairing", { timeout: 30000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon } = await pair(worker);
    const openHost = async () => {
      const response = await daemon.upgrade("host", { ...hostHeaders, Cookie: "" });
      assert.equal(response.status, 101);
      const socket = response.webSocket;
      socket.addEventListener("message", event => {
        if (typeof event.data === "string" && event.data.startsWith("\u001eoriel-heartbeat:")) {
          socket.send(event.data.replace("oriel-heartbeat:", "oriel-heartbeat-ack:"));
        }
      });
      socket.accept();
      return socket;
    };
    const waitFor = async status => {
      for (let attempt = 0; attempt < 140; attempt++) {
        const { data } = await owner.api("/api/devices");
        const row = data.devices.find(entry => entry.device_id === device);
        assert.ok(row, "disconnected devices remain registered");
        if (row.terminal_status === status) return row;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail(`device did not reach ${status}`);
    };

    let host = await openHost();
    assert.equal((await waitFor("online")).name, "integration-host");
    const firstTerminal = await owner.upgrade("client");
    assert.equal(firstTerminal.status, 101);
    firstTerminal.webSocket.accept();
    const terminalClosed = new Promise(resolve => firstTerminal.webSocket.addEventListener("close", resolve, { once: true }));
    host.close();
    assert.equal((await waitFor("grace")).terminal_status, "grace");
    assert.equal((await waitFor("offline")).name, "integration-host");
    assert.equal((await terminalClosed).code, 1013);
    assert.equal((await owner.upgrade("client")).status, 409);

    host = await openHost();
    assert.equal((await waitFor("online")).name, "integration-host");
    const reopened = await owner.upgrade("client");
    assert.equal(reopened.status, 101);
    reopened.webSocket.accept();
    host.close();
  } finally { await worker.dispose(); }
});
