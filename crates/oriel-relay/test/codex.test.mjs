import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {authenticator, client, device, hostHeaders, origin, pair, runtime} from "./helpers.mjs";

function observe(ws) {
  const messages = [], waits = [];
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data); const index = waits.findIndex(wait => wait.match(message));
    if (index < 0) messages.push(message); else { const [wait] = waits.splice(index, 1); clearTimeout(wait.timer); wait.resolve(message); }
  });
  return match => {
    const index = messages.findIndex(match);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const wait = {match, resolve, timer: setTimeout(() => { waits.splice(waits.indexOf(wait), 1); reject(Error("Codex frame timed out")); }, 5000)}; waits.push(wait);
    });
  };
}
const cookies = owner => [...owner.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
async function socket(worker, role, headers) {
  const response = await worker.dispatchFetch(`${origin}/api/codex/${device}/${role}`, {headers: {...headers, Upgrade: "websocket"}});
  assert.equal(response.status, 101); const ws = response.webSocket; const read = observe(ws);
  const ended = new Promise(resolve => ws.addEventListener("close", resolve));
  ws.accept(); return {ws, read, ended};
}
async function closed(connection) {
  let timer;
  try { return await Promise.race([connection.ended, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Codex closure timed out")), 5000); })]); }
  finally { clearTimeout(timer); }
}

test("Codex control fences account, browser Origin, host identity and request correlation", async () => {
  const worker = await runtime();
  try {
    const {owner} = await pair(worker);
    const stranger = client(worker); await stranger.enroll(authenticator());
    const browserHeaders = {Cookie: cookies(owner), Origin: origin};
    for (const [role, headers, expected] of [
      ["browser", {Cookie: cookies(stranger), Origin: origin}, 403],
      ["browser", {...browserHeaders, Origin: "https://foreign.example"}, 403],
      ["browser", {...browserHeaders, Authorization: hostHeaders.Authorization}, 403],
      ["host", {Authorization: "Bearer invalid"}, 401],
      ["host", browserHeaders, 401],
    ]) assert.equal((await worker.dispatchFetch(`${origin}/api/codex/${device}/${role}`, {headers: {...headers, Upgrade: "websocket"}})).status, expected);
    const host = await socket(worker, "host", hostHeaders);
    const browser = await socket(worker, "browser", browserHeaders);
    await browser.read(message => message.type === "state");
    assert.equal((await host.read(message => message.type === "snapshot")).type, "snapshot");
    host.ws.send(JSON.stringify({type: "state", engines: [{id: "e".repeat(32), title: "相談", requests: []}]}));
    const state = await browser.read(message => message.type === "state" && message.engines.length);
    assert.equal(state.engines[0].title, "相談");
    // Hibernating socket attachments are limited to 2 KiB. Approval content is
    // forwarded as frames, and fresh snapshots come from the host on reconnect.
    const largeState = {type:"state",engines:[{id:"e".repeat(32),title:"相談",requests:[{id:3,method:"item/commandExecution/requestApproval",params:{command:"x".repeat(8192)}}]}]};
    host.ws.send(JSON.stringify(largeState));
    assert.equal((await browser.read(message => message.type === "state" && message.engines[0]?.requests?.length)).engines[0].requests[0].params.command.length, 8192);
    const requestId = randomUUID();
    browser.ws.send(JSON.stringify({type: "rpc", request_id: requestId, engine: "e".repeat(32), method: "model/list", params: {}}));
    const request = await host.read(message => message.type === "request");
    assert.equal(request.request_id, requestId); assert.equal(request.method, "model/list");
    host.ws.send(JSON.stringify({type: "response", client: request.client, request_id: requestId, result: {data: [{model: "test"}]}}));
    assert.equal((await browser.read(message => message.type === "response")).result.data[0].model, "test");
    browser.ws.send(JSON.stringify({type: "rpc", request_id: randomUUID(), engine: "e".repeat(32), method: "command/exec", params: {command: "write outside project"}}));
    assert.equal((await browser.read(message => message.type === "rejected")).error, "Codex request rejected");
    host.ws.send(JSON.stringify({type: "event", engine: "e".repeat(32), message: {id: 12, method: "item/commandExecution/requestApproval", params: {command: "cargo test"}}}));
    assert.equal((await browser.read(message => message.type === "event")).message.params.command, "cargo test");
    await owner.api("/api/auth/logout", {});
    browser.ws.send(JSON.stringify({type: "rpc", request_id: randomUUID(), engine: "e".repeat(32), method: "thread/start", params: {}}));
    assert.equal((await closed(browser)).code, 1008);
    host.ws.close();
  } finally { await worker.dispose(); }
});

test("Codex host replacement and repository changes invalidate the previous control channel", async () => {
  const worker = await runtime();
  try {
    const {owner, daemon} = await pair(worker);
    const host = await socket(worker, "host", hostHeaders);
    host.ws.send(JSON.stringify({type:"heartbeat"}));
    await host.read(message => message.type === "heartbeat");
    const replacement = await socket(worker, "host", hostHeaders);
    assert.equal((await closed(host)).code, 1008);
    const browser = await socket(worker, "browser", {Cookie: cookies(owner), Origin: origin});
    await browser.read(message => message.type === "state");
    assert.equal((await daemon.api(`/api/integrations/${device}/repository`, {repository: {owner: "octocat", name: "connected"}}, hostHeaders)).status, 200);
    browser.ws.send(JSON.stringify({type: "rpc", request_id: randomUUID(), engine: "test", method: "thread/list", params: {}}));
    assert.equal((await closed(browser)).code, 1008);
    replacement.ws.close();
  } finally { await worker.dispose(); }
});
