import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import test from "node:test";
import vm from "node:vm";

test("pending Codex requests expire across hibernation without resending mutations or accepting late replies", async () => {
  let now = 1000;
  const device = {device_id: "a".repeat(32), user_id: "owner", host_hash: "b".repeat(64), repository_generation: "c".repeat(64)};
  const sockets = ["host", "browser"].map(role => ({
    readyState: 1, sent: [],
    attachment: {...device, protocol: "oriel/codex/v1", role, client_id: randomUUID(), session_hash: "d".repeat(64), expires_at: 200000, pending: []},
    deserializeAttachment() { return structuredClone(this.attachment); },
    serializeAttachment(value) { assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 2048); this.attachment = structuredClone(value); },
    send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; },
  }));
  const c = vm.createContext({WebSocket: {OPEN: 1}, Date: class extends Date {static now() {return now;}}});
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/codex.ts", import.meta.url), "utf8"), {mode: "transform"});
  vm.runInContext(source.replace("export class CodexConnections", "class CodexConnections") + "\nglobalThis.Controls = CodexConnections;", c);
  const create = () => new c.Controls({getWebSockets: () => sockets, getWebSocketAutoResponseTimestamp: () => new Date(now)}, () => device, () => 200000, () => {});
  let controls = create();
  const [host, browser] = sockets;
  const send = (id, method = "thread/list") => controls.message(browser, JSON.stringify({type: "rpc", request_id: id, engine: "engine", method, params: {}}));
  const ids = Array.from({length: 17}, randomUUID);
  for (const id of ids) send(id, "thread/start");
  assert.equal(host.sent.length, 16);
  assert.equal(browser.sent.at(-1).type, "rejected");
  now += 90000;
  controls = create(); // Runtime heap is gone; deadlines survive in attachments.
  await controls.alarm();
  assert.equal(browser.attachment.pending.length, 0);
  assert.equal(browser.sent.filter(message => message.type === "response").length, 16);
  assert.equal(host.sent.length, 16, "No mutation is retried");
  send(ids[16]);
  assert.equal(host.sent.length, 17);
  const before = browser.sent.length;
  controls.message(host, JSON.stringify({type: "response", client: browser.attachment.client_id, request_id: ids[0], result: "late"}));
  assert.equal(browser.sent.length, before);
  controls.message(host, JSON.stringify({type: "response", client: browser.attachment.client_id, request_id: ids[16], result: "new"}));
  assert.equal(browser.sent.at(-1).result, "new");
  assert.equal(browser.attachment.pending.length, 0);
});
