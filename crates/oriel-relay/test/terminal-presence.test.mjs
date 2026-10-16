import test from "node:test";
import WebSocket from "ws";
import assert from "node:assert/strict";
import { origin, device, hostHeaders, runtime, pair, client, authenticator } from "./helpers.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function state(owner) {
  return (await owner.api("/api/devices")).data.devices.find(row => row.device_id === device)?.terminal_status;
}
async function until(owner, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await state(owner) === expected) return;
    await wait(20);
  }
  assert.equal(await state(owner), expected);
}
async function host(daemon, reply = true) {
  const response = await daemon.upgrade("host", hostHeaders);
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.addEventListener("message", event => {
    if (reply && typeof event.data === "string" && event.data.startsWith("oriel-heartbeat:")) socket.send(event.data);
  });
  socket.accept();
  return socket;
}

test("Automatic host keepalive and terminal frames need no presence reads or writes after hibernation", { timeout: 45000 }, async () => {
  const worker = await runtime({}, undefined, true);
  let timer;
  try {
    const { owner, daemon } = await pair(worker);
    const terminal = await host(daemon);
    await until(owner, "online");
    const costs = async () => (await worker.dispatchFetch(`${origin}/__terminal-cost-for-test?device=${device}`)).json();
    terminal.send("oriel:ping");
    timer = setInterval(() => terminal.send("oriel:ping"), 10000);
    await wait(50);
    const before = await costs();
    await wait(31000);
    const after = await costs();
    assert.ok(after.gets <= before.gets, "A wake may reset counters but must not reload presence");
    assert.ok(after.puts <= before.puts);
    await worker.unsafeEvictDurableObject("oriel-relay", "RelayDevice", { name: device });
    assert.equal(await state(owner), "online");
    const cold = await costs();
    assert.equal(cold.gets, 0, "Host attachment must restore presence without a storage read");
    assert.equal(cold.puts, 0);
    const client = await owner.upgrade("client");
    client.webSocket.accept();
    const received = new Promise(resolve => client.webSocket.addEventListener("message", event => resolve(event.data), { once: true }));
    terminal.send("hibernated output");
    assert.equal(await received, "hibernated output");
    const output = await costs();
    assert.equal(output.gets, 0);
    assert.equal(output.puts, 0);
    console.log("Automatic terminal presence operations:", JSON.stringify({ before, after, cold, output }));
  } finally { clearInterval(timer); await worker.dispose(); }
});

test("registrations remain offline without a host; internal state route stays private", { timeout: 15000 }, async () => {
  const worker = await runtime();
  try {
    const { owner } = await pair(worker);
    assert.equal(await state(owner), "offline");
    assert.equal((await owner.upgrade("client")).status, 409);
    const response = await worker.dispatchFetch(`${origin}/internal/terminal-status`);
    assert.equal(response.status, 404);
    assert.equal((await owner.api("/api/devices")).data.devices.length, 1);
  } finally { await worker.dispose(); }
});

test("unresponsive legacy host stays unknown and cannot accept a client", { timeout: 15000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon } = await pair(worker);
    await host(daemon, false);
    assert.equal(await state(owner), "unknown");
    assert.equal((await owner.upgrade("client")).status, 409);
    await worker.unsafeEvictDurableObject("oriel-relay", "RelayDevice", { name: device });
    assert.equal(await state(owner), "unknown");
  } finally { await worker.dispose(); }
});

test("silent healthy host and browser disconnect do not change terminal availability", { timeout: 45000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon } = await pair(worker);
    await host(daemon);
    await until(owner, "online");
    const client = await owner.upgrade("client");
    assert.equal(client.status, 101);
    client.webSocket.accept();
    client.webSocket.send("oriel-heartbeat:forged-client-response");
    client.webSocket.close();
    // Frequent queries must not postpone heartbeat alarms.
    for (let iteration = 0; iteration < 8; iteration++) {
      await wait(5000);
      assert.equal(await state(owner), "online");
    }
    await worker.unsafeEvictDurableObject("oriel-relay", "RelayDevice", { name: device });
    assert.equal(await state(owner), "online");
  } finally { await worker.dispose(); }
});

test("reconnecting within grace preserves client; stale host events do not disconnect replacement", { timeout: 15000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon } = await pair(worker);
    const first = await host(daemon);
    await until(owner, "online");
    const client = await owner.upgrade("client");
    client.webSocket.accept();
    let closed = false;
    client.webSocket.addEventListener("close", () => { closed = true; });
    first.close();
    await until(owner, "grace");
    const replacement = await host(daemon);
    await until(owner, "online");
    const output = new Promise(resolve => client.webSocket.addEventListener("message", event => resolve(event.data), { once: true }));
    replacement.send("restored output");
    assert.equal(await output, "restored output");
    await wait(5100);
    assert.equal(await state(owner), "online");
    assert.equal(closed, false);
  } finally { await worker.dispose(); }
});

test("close has five seconds of grace; same registration recovers after offline", { timeout: 15000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon } = await pair(worker);
    const first = await host(daemon);
    await until(owner, "online");
    first.close();
    await until(owner, "grace");
    await wait(1000);
    assert.equal(await state(owner), "grace");
    assert.equal((await owner.upgrade("client")).status, 409);
    await wait(4100);
    await until(owner, "offline");
    await host(daemon);
    await until(owner, "online");
    assert.equal((await owner.api("/api/devices")).data.devices.length, 1);
    const client = await owner.upgrade("client");
    assert.equal(client.status, 101);
    client.webSocket.accept();
  } finally { await worker.dispose(); }
});

test("a host that stops replying expires only after the heartbeat grace", { timeout: 45000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon } = await pair(worker);
    const response = await daemon.upgrade("host", hostHeaders);
    const socket = response.webSocket;
    let replied = false;
    let firstChallenge;
    socket.addEventListener("message", event => {
      if (!replied && typeof event.data === "string" && event.data.startsWith("oriel-heartbeat:")) {
        replied = true;
        firstChallenge = event.data;
        socket.send(event.data);
      }
    });
    socket.accept();
    await until(owner, "online");
    const client = await owner.upgrade("client");
    client.webSocket.accept();
    let closed = false;
    client.webSocket.addEventListener("close", () => { closed = true; });
    await wait(20_000);
    // Replaying an already accepted proof must not renew availability.
    socket.send(firstChallenge);
    await wait(9000);
    assert.equal(await state(owner), "online");
    await wait(2000);
    assert.equal(await state(owner), "grace");
    assert.equal(closed, false);
    await wait(4100);
    await until(owner, "offline");
    assert.equal((await owner.upgrade("client")).status, 409);
    assert.equal((await owner.api("/api/devices")).data.devices.length, 1);
  } finally { await worker.dispose(); }
});

async function terminalSetup(worker) {
  const paired = await pair(worker);
  const server = await host(paired.daemon);
  await until(paired.owner, "online");
  const namespace = await worker.getDurableObjectNamespace("ACCOUNTS");
  const account = namespace.get(namespace.idFromName("accounts"));
  return { ...paired, server, account };
}
// Miniflare's dispatchFetch socket waits up to 30 seconds for TCP teardown
// after an idle hibernatable socket receives a close frame. Use the real HTTP
// transport with a bounded closing handshake. This timeout starts only after
// close is initiated; a missing server close still times out the test, and an
// abnormal termination produces 1006 instead of the required 4003.
async function terminalBrowser(worker, owner) {
  const endpoint = new URL(`/device/${device}/client`, await worker.ready);
  endpoint.protocol = "ws:";
  const socket = new WebSocket(endpoint, "oriel-client", {
    closeTimeout: 1000,
    headers: {
      Origin: origin,
      Cookie: [...owner.cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}
function closed(socket) {
  return new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
}
function next(socket) {
  return new Promise(resolve => socket.addEventListener("message", event => resolve(event.data), { once: true }));
}
async function gateEntered(account) {
  for (let i = 0; i < 100; i++) {
    if (await account.terminalGateStatusForTest()) return;
    await wait(10);
  }
  assert.fail("authorization gate was not reached");
}

test("logout closes its terminal, denies the old cookie, and keeps host and other sessions valid", { timeout: 15000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon, key, server } = await terminalSetup(worker);
    const response = await owner.upgrade("client", { "X-Oriel-Terminal": "forged" });
    assert.equal(response.status, 101);
    const browser = response.webSocket;
    browser.accept();
    for (const value of ["text", new Uint8Array([0, 255, 128])]) {
      const input = next(server);
      browser.send(value);
      const delivered = await input;
      if (typeof value === "string") assert.equal(delivered, value);
      else assert.deepEqual(new Uint8Array(delivered), value);
      const output = next(browser);
      server.send(value);
      const received = await output;
      if (typeof value === "string") assert.equal(received, value);
      else assert.deepEqual(new Uint8Array(received), value);
    }
    const oldCookie = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const disconnected = closed(browser);
    assert.equal((await owner.api("/api/auth/logout", {})).status, 200);
    await disconnected;
    let leaked = false;
    browser.addEventListener("message", () => { leaked = true; });
    server.send("after logout");
    assert.equal((await owner.upgrade("client", { Cookie: oldCookie, "X-Oriel-Terminal": "forged" })).status, 401);
    assert.equal((await worker.dispatchFetch(`${origin}/terminal-session`, {method:"POST", body:"{}"})).status, 404);
    assert.equal((await worker.dispatchFetch(`${origin}/internal/revoke`, {method:"POST", body:"forged"})).status, 404);
    const options = await owner.api("/api/auth/login/options", {});
    assert.equal((await owner.api("/api/auth/login/verify", {credential:key.login(options.data.options)})).status, 200);
    const current = await owner.upgrade("client");
    assert.equal(current.status, 101);
    current.webSocket.accept();
    // Retrying an old logout must not close the replacement session.
    assert.equal((await owner.api("/api/auth/logout", {}, {Cookie:oldCookie})).status, 200);
    const output = next(current.webSocket);
    server.send("new session");
    assert.equal(await output, "new session");
    assert.equal(leaked, false);
    assert.equal((await daemon.upgrade("host", hostHeaders)).status, 101);
  } finally { await worker.dispose(); }
});

for (const direction of ["input", "output"]) test(`logout wins a pending ${direction} authorization`, { timeout:15000 }, async () => {
  const worker = await runtime();
  let account;
  try {
    const setup = await terminalSetup(worker);
    account = setup.account;
    const response = await setup.owner.upgrade("client");
    const browser = response.webSocket;
    browser.accept();
    const target = direction === "input" ? setup.server : browser;
    let leaked = false;
    target.addEventListener("message", event => { if (event.data === "racing frame") leaked = true; });
    await account.setTerminalGateForTest("frame");
    (direction === "input" ? browser : setup.server).send("racing frame");
    await gateEntered(account);
    assert.equal((await setup.owner.api("/api/auth/logout", {})).status, 200);
    await account.releaseTerminalGateForTest();
    await wait(100);
    assert.equal(leaked, false);
  } finally { await account?.releaseTerminalGateForTest(); await worker.dispose(); }
});

test("logout between grant registration and upgrade denies connection", {timeout:15000}, async () => {
  const worker = await runtime();
  let account;
  try {
    const setup = await terminalSetup(worker);
    account = setup.account;
    await account.setTerminalGateForTest("upgrade");
    const pending = setup.owner.upgrade("client");
    await gateEntered(account);
    assert.equal((await setup.owner.api("/api/auth/logout", {})).status, 200);
    await account.releaseTerminalGateForTest();
    assert.equal((await pending).status, 403);
  } finally { await account?.releaseTerminalGateForTest(); await worker.dispose(); }
});

for (const evict of [false, true]) test(`idle session expires with hibernation=${evict}`, { timeout:15000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, account } = await terminalSetup(worker);
    await account.accountSqlForTest("UPDATE sessions SET expires_at = ?", [Math.floor(Date.now()/1000) + 2]);
    const browser = await terminalBrowser(worker, owner);
    const disconnected = closed(browser);
    if (evict) await worker.unsafeEvictDurableObject("oriel-relay", "RelayDevice", {name:device});
    assert.equal((await disconnected).code, 4003);
    assert.equal((await owner.upgrade("client")).status, 401);
  } finally { await worker.dispose(); }
});

test("authorization service failure closes browser without forwarding", {timeout:15000}, async () => {
  const worker = await runtime();
  try {
    const { owner, server, account } = await terminalSetup(worker);
    const browser = await terminalBrowser(worker, owner);
    const disconnected = closed(browser);
    let leaked = false;
    browser.addEventListener("message", () => { leaked = true; });
    await account.failTerminalForTest(true);
    server.send("must fail closed");
    assert.equal((await disconnected).code, 4003);
    assert.equal(leaked, false);
  } finally { await worker.dispose(); }
});

test("failed logout retains revocation targets and the same cookie can retry", {timeout:15000}, async () => {
  const worker = await runtime();
  try {
    const { owner, account } = await terminalSetup(worker);
    const browser = await terminalBrowser(worker, owner);
    const disconnected = closed(browser);
    await account.failRevocationForTest(true);
    assert.equal((await owner.api("/api/auth/logout", {})).status, 503);
    assert.equal((await owner.upgrade("client")).status, 401);
    assert.equal((await account.accountSqlForTest("SELECT * FROM terminal_sessions", [])).length, 1);
    await account.failRevocationForTest(false);
    assert.equal((await owner.api("/api/auth/logout", {})).status, 200);
    assert.equal((await disconnected).code, 4003);
    assert.equal((await account.accountSqlForTest("SELECT * FROM terminal_sessions", [])).length, 0);
  } finally { await worker.dispose(); }
});

test("another session and another account logout preserve the current browser", {timeout:15000}, async () => {
  const worker = await runtime();
  try {
    const { owner, key, server } = await terminalSetup(worker);
    const second = client(worker);
    const options = await second.api("/api/auth/login/options", {});
    assert.equal((await second.api("/api/auth/login/verify", {credential:key.login(options.data.options)})).status, 200);
    const first = await terminalBrowser(worker, owner);
    const replaced = closed(first);
    const current = await terminalBrowser(worker, second);
    assert.equal((await replaced).code, 4003);
    assert.equal((await owner.api("/api/auth/logout", {})).status, 200);
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    assert.equal((await stranger.api("/api/auth/logout", {})).status, 200);
    const output = next(current);
    server.send("unrelated logouts");
    assert.equal(await output, "unrelated logouts");
    const input = next(server);
    current.send("still authorized");
    assert.equal(await input, "still authorized");
  } finally { await worker.dispose(); }
});

test("persistSession replacement revokes the previous terminal session", {timeout:15000}, async () => {
  const worker = await runtime();
  try {
    const { owner } = await terminalSetup(worker);
    const browser = await terminalBrowser(worker, owner);
    const disconnected = closed(browser);
    await owner.enroll(authenticator());
    assert.equal((await disconnected).code, 4003);
    assert.equal((await owner.upgrade("client")).status, 101);
  } finally { await worker.dispose(); }
});

test("a stale host frame authorization cannot cross a host generation", {timeout:15000}, async () => {
  const worker = await runtime();
  let account;
  try {
    const setup = await terminalSetup(worker);
    account = setup.account;
    const response = await setup.owner.upgrade("client");
    response.webSocket.accept();
    let stale = false;
    response.webSocket.addEventListener("message", event => { if (event.data === "old host") stale = true; });
    await account.setTerminalGateForTest("frame");
    setup.server.send("old host");
    await gateEntered(account);
    const replacement = await host(setup.daemon);
    await until(setup.owner, "online");
    await account.releaseTerminalGateForTest();
    const output = next(response.webSocket);
    replacement.send("new host");
    assert.equal(await output, "new host");
    assert.equal(stale, false);
  } finally { await account?.releaseTerminalGateForTest(); await worker.dispose(); }
});

test("every terminal frame consults account SQL without adding presence storage writes", {timeout:15000}, async () => {
  const worker = await runtime({}, undefined, true);
  try {
    const { owner, server, account } = await terminalSetup(worker);
    const response = await owner.upgrade("client");
    response.webSocket.accept();
    const before = await account.costForTest();
    for (let i = 0; i < 3; i++) {
      const input = next(server);
      response.webSocket.send(`input ${i}`);
      assert.equal(await input, `input ${i}`);
      const output = next(response.webSocket);
      server.send(`output ${i}`);
      assert.equal(await output, `output ${i}`);
    }
    const after = await account.costForTest();
    assert.ok(after.reads >= before.reads + 6, "No positive frame authorization cache");
    console.log("Terminal account authorization SQL:", JSON.stringify({before, after}));
  } finally { await worker.dispose(); }
});
