import test from "node:test";
import assert from "node:assert/strict";
import { origin, device, hostHeaders, runtime, pair } from "./helpers.mjs";

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
